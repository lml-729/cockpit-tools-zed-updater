// Kept in a separate file so the updater can copy the same tested probe into Cockpit.
// Protocol reference: Zed cloud_llm_client::CompletionEvent / CompletionRequestStatus.
const ZED_PROBE_MAX_BODY_BYTES: usize = 256 * 1024;
type ZedProbeOutcome = (Option<bool>, &'static str);

fn is_zed_student_plan(user_raw: &Value) -> bool {
    let plan = pick_first_string(&[
        json_nested_str(user_raw, &["plan", "plan_v3"]),
        json_nested_str(user_raw, &["plan", "plan_v2"]),
        json_nested_str(user_raw, &["plan", "plan"]),
    ]);
    if plan
        .as_deref()
        .is_some_and(|p| p.eq_ignore_ascii_case("zed_student"))
    {
        return true;
    }
    json_nested_str(user_raw, &["default_organization_id"])
        .and_then(|id| json_nested_str(user_raw, &["plans_by_organization", &id]))
        .is_some_and(|p| p.eq_ignore_ascii_case("zed_student"))
}

// Inspect structured errors only. Never interpret HTML or a substring in an arbitrary
// proxy response as proof of exhaustion. Zed sometimes puts provider JSON in message.
fn zed_probe_error_reason(value: &Value, depth: usize) -> Option<&'static str> {
    if depth > 12 {
        return None;
    }
    let mut reason = None;
    match value {
        Value::Object(object) => {
            for (key, child) in object {
                if let Some(text) = child.as_str() {
                    let text_lower = text.to_ascii_lowercase();
                    let found = match (key.as_str(), text_lower.as_str()) {
                        ("code" | "type", "token_spend_limit_reached") => Some("quota_exhausted"),
                        ("code" | "type", "permission_error" | "permission_denied") => {
                            Some("permission_denied")
                        }
                        ("code" | "type", "authentication_error" | "authentication_failed") => {
                            Some("authentication_failed")
                        }
                        ("code" | "type", "payment_required") => Some("payment_required"),
                        (
                            "code" | "type",
                            "rate_limit_error" | "rate_limited" | "rate_limit_exceeded",
                        ) => Some("rate_limited"),
                        ("message", _) if text_lower.contains("student plan credits consumed") => {
                            Some("quota_exhausted")
                        }
                        _ => None,
                    };
                    if found == Some("quota_exhausted") {
                        return found;
                    }
                    reason = reason.or(found);
                    if matches!(key.as_str(), "message" | "error") {
                        if let Ok(nested) = serde_json::from_str::<Value>(text) {
                            let found = zed_probe_error_reason(&nested, depth + 1);
                            if found == Some("quota_exhausted") {
                                return found;
                            }
                            reason = reason.or(found);
                        }
                    }
                }
                let found = zed_probe_error_reason(child, depth + 1);
                if found == Some("quota_exhausted") {
                    return found;
                }
                reason = reason.or(found);
            }
        }
        Value::Array(items) => {
            for child in items {
                let found = zed_probe_error_reason(child, depth + 1);
                if found == Some("quota_exhausted") {
                    return found;
                }
                reason = reason.or(found);
            }
        }
        _ => {}
    }
    reason
}

fn zed_probe_outcome_for_reason(reason: &'static str) -> ZedProbeOutcome {
    match reason {
        "quota_exhausted" | "permission_denied" | "authentication_failed" | "payment_required" => {
            (Some(false), reason)
        }
        _ => (None, reason),
    }
}

fn zed_probe_http_failure(status: u16, body: &[u8]) -> ZedProbeOutcome {
    if status == 429 {
        return (None, "rate_limited");
    }
    if status >= 500 {
        return (None, "unknown");
    }
    let Ok(value) = serde_json::from_slice::<Value>(body) else {
        return (None, "unknown");
    };
    if !value.is_object() {
        return (None, "unknown");
    }
    if let Some(reason) = zed_probe_error_reason(&value, 0) {
        return zed_probe_outcome_for_reason(reason);
    }
    match status {
        401 => (Some(false), "authentication_failed"),
        402 => (Some(false), "payment_required"),
        403 => (Some(false), "permission_denied"),
        _ => (None, "unknown"),
    }
}

fn zed_probe_completion(body: &[u8], wrapped: bool) -> ZedProbeOutcome {
    let Ok(body) = std::str::from_utf8(body) else {
        return (None, "unknown");
    };
    let mut started = false;
    let mut stopped = false;
    let mut stream_ended = false;
    let mut failure = None;
    for line in body.lines().filter(|line| !line.trim().is_empty()) {
        let Ok(value) = serde_json::from_str::<Value>(line) else {
            return failure
                .map(zed_probe_outcome_for_reason)
                .unwrap_or((None, "unknown"));
        };
        if let Some(reason) = zed_probe_error_reason(&value, 0) {
            if failure != Some("quota_exhausted") {
                failure = Some(reason);
            }
        }
        if let Some(status) = value.get("status") {
            if status.get("failed").is_some() {
                failure = failure.or(Some("unknown"));
            } else if status.as_str() == Some("stream_ended") {
                // A rejected provider request may end without message_start/message_stop.
                // Preserve its explicit failure; provider lifecycle is checked for success.
                stream_ended = true;
            } else if status.as_str() != Some("started") && status.get("queued").is_none() {
                failure = failure.or(Some("unknown"));
            }
            continue;
        }
        let event = if wrapped {
            match value.get("event") {
                Some(event) => event,
                None => {
                    failure = failure.or(Some("unknown"));
                    continue;
                }
            }
        } else {
            &value
        };
        match event.get("type").and_then(Value::as_str) {
            Some("error") => failure = failure.or(Some("unknown")),
            Some("message_start") if !started && !stopped && !stream_ended => started = true,
            Some("message_stop") if started && !stopped && !stream_ended => stopped = true,
            Some("message_start" | "message_stop") => {
                return failure
                    .map(zed_probe_outcome_for_reason)
                    .unwrap_or((None, "unknown"));
            }
            Some(
                "content_block_start"
                | "content_block_delta"
                | "content_block_stop"
                | "message_delta",
            ) if started && !stopped && !stream_ended => {}
            Some("ping") if !stream_ended => {}
            _ => failure = failure.or(Some("unknown")),
        }
    }
    if let Some(reason) = failure {
        return zed_probe_outcome_for_reason(reason);
    }
    if started && stopped && (!wrapped || stream_ended) {
        (Some(true), "available")
    } else {
        (None, "unknown")
    }
}

fn select_zed_student_probe_model(models_raw: &Value) -> Option<String> {
    let models = models_raw.get("models")?.as_array()?;
    let candidates: Vec<&Value> = models
        .iter()
        .filter(|model| {
            model.get("provider").and_then(Value::as_str) == Some("anthropic")
                && !model
                    .get("is_disabled")
                    .and_then(Value::as_bool)
                    .unwrap_or(false)
        })
        .collect();
    let default_fast = models_raw.get("default_fast_model").and_then(Value::as_str);
    candidates
        .iter()
        .find(|m| default_fast.is_some() && m.get("id").and_then(Value::as_str) == default_fast)
        .or_else(|| {
            candidates.iter().find(|m| {
                m.get("id")
                    .and_then(Value::as_str)
                    .is_some_and(|id| id.to_ascii_lowercase().contains("haiku"))
            })
        })
        .or_else(|| candidates.first())
        .and_then(|m| m.get("id").and_then(Value::as_str))
        .map(str::to_owned)
}

fn zed_probe_append_body(body: &mut Vec<u8>, chunk: &[u8]) -> Result<(), ()> {
    if chunk.len() > ZED_PROBE_MAX_BODY_BYTES.saturating_sub(body.len()) {
        return Err(());
    }
    body.extend_from_slice(chunk);
    Ok(())
}

async fn zed_probe_read_body(mut response: reqwest::Response) -> Result<Vec<u8>, ()> {
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| ())? {
        zed_probe_append_body(&mut body, &chunk)?;
    }
    Ok(body)
}

fn zed_probe_finish(
    outcome: ZedProbeOutcome,
    checked_at: i64,
    status: u16,
) -> (Option<bool>, i64, &'static str) {
    // Do not include the response, credentials, request URL, or transport error in logs.
    logger::log_warn(&format!(
        "[Zed] Student Hosted AI probe: status={}, reason={}",
        status, outcome.1
    ));
    (outcome.0, checked_at, outcome.1)
}

async fn probe_zed_hosted_ai_availability(
    client: &reqwest::Client,
    authorization_header: &str,
    user_raw: &Value,
) -> (Option<bool>, i64, &'static str) {
    let checked_at = now_ts();
    let unknown = (None, "unknown");
    let Some(organization_id) = json_nested_str(user_raw, &["default_organization_id"]) else {
        return zed_probe_finish(unknown, checked_at, 0);
    };
    let timeout = std::time::Duration::from_secs(20);
    let token_response = match client
        .post(format!("{}/client/llm_tokens", ZED_CLOUD_BASE_URL))
        .header("Authorization", authorization_header)
        .timeout(timeout)
        .json(&json!({"organization_id": organization_id}))
        .send()
        .await
    {
        Ok(response) => response,
        Err(_) => return zed_probe_finish(unknown, checked_at, 0),
    };
    let status = token_response.status().as_u16();
    let Ok(body) = zed_probe_read_body(token_response).await else {
        return zed_probe_finish(unknown, checked_at, status);
    };
    if !(200..300).contains(&status) {
        return zed_probe_finish(zed_probe_http_failure(status, &body), checked_at, status);
    }
    let token_raw = serde_json::from_slice::<Value>(&body).ok();
    let Some(llm_token) = token_raw
        .as_ref()
        .and_then(|v| v.get("token"))
        .and_then(Value::as_str)
        .filter(|t| !t.trim().is_empty())
    else {
        return zed_probe_finish(zed_probe_http_failure(status, &body), checked_at, status);
    };
    let models_response = match client
        .get(format!("{}/models", ZED_CLOUD_BASE_URL))
        .header("Authorization", format!("Bearer {}", llm_token))
        .header("x-zed-client-supports-x-ai", "true")
        .timeout(timeout)
        .send()
        .await
    {
        Ok(response) => response,
        Err(_) => return zed_probe_finish(unknown, checked_at, 0),
    };
    let status = models_response.status().as_u16();
    let Ok(body) = zed_probe_read_body(models_response).await else {
        return zed_probe_finish(unknown, checked_at, status);
    };
    if !(200..300).contains(&status) {
        return zed_probe_finish(zed_probe_http_failure(status, &body), checked_at, status);
    }
    let Some(model_id) = serde_json::from_slice::<Value>(&body)
        .ok()
        .and_then(|v| select_zed_student_probe_model(&v))
    else {
        return zed_probe_finish(zed_probe_http_failure(status, &body), checked_at, status);
    };
    // This minimal completion traverses the Student credit gate; minting a token or
    // fetching models alone does not establish availability. Never retry a completion.
    let response = match client
        .post(format!("{}/completions", ZED_CLOUD_BASE_URL))
        .header("Authorization", format!("Bearer {}", llm_token))
        .header("x-zed-client-supports-status-messages", "true")
        .header(
            "x-zed-client-supports-stream-ended-request-completion-status",
            "true",
        )
        .timeout(timeout)
        .json(&json!({
            "provider": "anthropic", "model": model_id,
            "provider_request": {
                "model": model_id, "max_tokens": 1,
                "messages": [{"role": "user", "content": [{"type": "text", "text": "."}]}],
                "tools": [], "stop_sequences": []
            }
        }))
        .send()
        .await
    {
        Ok(response) => response,
        Err(_) => return zed_probe_finish(unknown, checked_at, 0),
    };
    let status = response.status().as_u16();
    // Zed checks presence, rather than value, of this server capability header.
    let wrapped = response
        .headers()
        .contains_key("x-zed-server-supports-status-messages");
    let Ok(body) = zed_probe_read_body(response).await else {
        return zed_probe_finish(unknown, checked_at, status);
    };
    let outcome = if (200..300).contains(&status) {
        zed_probe_completion(&body, wrapped)
    } else {
        zed_probe_http_failure(status, &body)
    };
    zed_probe_finish(outcome, checked_at, status)
}

#[cfg(test)]
mod zed_hosted_ai_tests {
    use super::*;

    fn ndjson(values: &[Value]) -> Vec<u8> {
        values
            .iter()
            .map(|v| format!("{}\n", v))
            .collect::<String>()
            .into_bytes()
    }

    #[test]
    fn http_200_failed_nested_student_credits_is_exhausted() {
        let body = ndjson(&[json!({"status":{"failed":{
            "code":"permission_error", "message": "{\"error\":{\"type\":\"permission_error\",\"message\":\"STUDENT PLAN CREDITS CONSUMED\"}}"
        }}})]);
        assert_eq!(
            zed_probe_completion(&body, true),
            (Some(false), "quota_exhausted")
        );
        assert_eq!(
            zed_probe_completion(
                &ndjson(&[json!({"status":{"failed":{"code":"token_spend_limit_reached"}}})]),
                true
            ),
            (Some(false), "quota_exhausted")
        );
    }

    #[test]
    fn event_error_and_late_failure_override_http_200_success() {
        let body = ndjson(&[
            json!({"event":{"type":"message_start"}}),
            json!({"event":{"type":"message_stop"}}),
            json!({"event":{"type":"error", "error":{"type":"permission_error", "message":"denied"}}}),
            json!({"status":"stream_ended"}),
        ]);
        assert_eq!(
            zed_probe_completion(&body, true),
            (Some(false), "permission_denied")
        );
    }

    #[test]
    fn explicit_rejection_survives_gateway_end_or_later_malformed_event() {
        for (code, reason) in [
            ("token_spend_limit_reached", "quota_exhausted"),
            ("permission_error", "permission_denied"),
        ] {
            let failure = json!({"status":{"failed":{"code":code,"message":"rejected"}}});
            assert_eq!(
                zed_probe_completion(
                    &ndjson(&[failure.clone(), json!({"status":"stream_ended"})]),
                    true
                ),
                (Some(false), reason)
            );
            let mut malformed = ndjson(&[failure.clone()]);
            malformed.extend_from_slice(b"{truncated");
            assert_eq!(
                zed_probe_completion(&malformed, true),
                (Some(false), reason)
            );
            let late = ndjson(&[
                json!({"event":{"type":"message_start"}}),
                json!({"event":{"type":"message_stop"}}),
                json!({"status":"stream_ended"}),
                failure,
            ]);
            assert_eq!(zed_probe_completion(&late, true), (Some(false), reason));
        }
        assert_eq!(
            zed_probe_completion(&ndjson(&[json!({"status":"stream_ended"})]), true),
            (None, "unknown")
        );
    }

    #[test]
    fn wrapped_success_requires_provider_and_gateway_end() {
        let events = [
            json!({"status":"started"}),
            json!({"event":{"type":"message_start"}}),
            json!({"event":{"type":"message_delta"}}),
            json!({"event":{"type":"message_stop"}}),
            json!({"status":"stream_ended"}),
        ];
        assert_eq!(
            zed_probe_completion(&ndjson(&events), true),
            (Some(true), "available")
        );
        assert_eq!(
            zed_probe_completion(&ndjson(&events[..4]), true),
            (None, "unknown")
        );
        assert_eq!(
            zed_probe_completion(&ndjson(&events[..2]), true),
            (None, "unknown")
        );
        assert_eq!(zed_probe_completion(b"", true), (None, "unknown"));
        assert_eq!(
            zed_probe_completion(b"{\"event\":", true),
            (None, "unknown")
        );
    }

    #[test]
    fn legacy_stream_must_still_complete() {
        let events = [
            json!({"type":"message_start"}),
            json!({"type":"message_stop"}),
        ];
        assert_eq!(
            zed_probe_completion(&ndjson(&events), false),
            (Some(true), "available")
        );
        assert_eq!(
            zed_probe_completion(&ndjson(&events), true),
            (None, "unknown")
        );
        assert_eq!(
            zed_probe_completion(&ndjson(&events[..1]), false),
            (None, "unknown")
        );
    }

    #[test]
    fn split_transport_chunks_are_reassembled_before_parsing() {
        let wire = ndjson(&[
            json!({"event":{"type":"message_start"}}),
            json!({"event":{"type":"message_stop"}}),
            json!({"status":"stream_ended"}),
        ]);
        let mut body = Vec::new();
        for chunk in wire.chunks(3) {
            zed_probe_append_body(&mut body, chunk).unwrap();
        }
        assert_eq!(zed_probe_completion(&body, true), (Some(true), "available"));
        let mut oversize = vec![0; ZED_PROBE_MAX_BODY_BYTES];
        assert!(zed_probe_append_body(&mut oversize, b"x").is_err());
    }

    #[test]
    fn html_and_gateway_errors_remain_unknown() {
        assert_eq!(
            zed_probe_http_failure(403, b"<html>Student plan credits consumed</html>"),
            (None, "unknown")
        );
        assert_eq!(
            zed_probe_http_failure(503, br#"{"code":"permission_error"}"#),
            (None, "unknown")
        );
        assert_eq!(
            zed_probe_http_failure(429, b"retry later"),
            (None, "rate_limited")
        );
        for (status, reason) in [
            (401, "authentication_failed"),
            (402, "payment_required"),
            (403, "permission_denied"),
        ] {
            assert_eq!(
                zed_probe_http_failure(status, br#"{"message":"denied"}"#),
                (Some(false), reason)
            );
        }
        assert_eq!(
            zed_probe_completion(b"<html>ok</html>", false),
            (None, "unknown")
        );
    }

    #[test]
    fn model_selection_and_zero_legacy_limit_do_not_infer_exhaustion() {
        let raw = json!({"default_fast_model":"disabled-haiku", "models":[
            {"provider":"anthropic", "id":"disabled-haiku", "is_disabled":true},
            {"provider":"open_ai", "id":"other-fast"}, {"provider":"anthropic", "id":"claude-haiku"}
        ]});
        assert_eq!(
            select_zed_student_probe_model(&raw).as_deref(),
            Some("claude-haiku")
        );
        let account = json!({"plan":{"plan":"zed_free", "plan_v3":"zed_student", "usage":{"model_requests":{"limit":{"limited":0}, "used":0}}}});
        assert!(is_zed_student_plan(&account));
        assert_eq!(zed_probe_error_reason(&account, 0), None);
    }
}

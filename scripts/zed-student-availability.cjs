const fs = require('node:fs');
const path = require('node:path');

// Patched against the official stable Cockpit source and validated in GitHub Actions.
function replaceOnce(text, from, to) {
  if (text.split(from).length !== 2) {
    throw new Error(`Upstream source changed; expected exactly one patch anchor: ${from.slice(0, 80)}`);
  }
  return text.replace(from, to);
}

function readText(file) {
  return fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
}

function applyZedStudentAvailability(root) {
  const rustModelPath = path.join(root, 'src-tauri/src/models/zed.rs');
  const rustAccountPath = path.join(root, 'src-tauri/src/modules/zed_account.rs');
  const tsTypePath = path.join(root, 'src/types/zed.ts');
  const pagePath = path.join(root, 'src/pages/ZedAccountsPage.tsx');

  let rustModel = readText(rustModelPath);
  rustModel = replaceOnce(
    rustModel,
    `    #[serde(skip_serializing_if = "Option::is_none")]\n    pub token_spend_remaining_cents: Option<i64>,\n`,
    `    #[serde(skip_serializing_if = "Option::is_none")]\n    pub token_spend_remaining_cents: Option<i64>,\n    #[serde(default, skip_serializing_if = "Option::is_none")]\n    pub hosted_ai_available: Option<bool>,\n    #[serde(default, skip_serializing_if = "Option::is_none")]\n    pub hosted_ai_checked_at: Option<i64>,\n`,
  );

  let tsType = readText(tsTypePath);
  tsType = replaceOnce(
    tsType,
    `  token_spend_remaining_cents?: number | null;\n`,
    `  token_spend_remaining_cents?: number | null;\n  hosted_ai_available?: boolean | null;\n  hosted_ai_checked_at?: number | null;\n`,
  );

  let rustAccount = readText(rustAccountPath);
  rustAccount = replaceOnce(
    rustAccount,
    `    preferences_raw: Value,\n}\n`,
    `    preferences_raw: Value,\n    hosted_ai_available: Option<bool>,\n    hosted_ai_checked_at: Option<i64>,\n}\n`,
  );

  const fetchSignature = `async fn fetch_remote_bundle(user_id: &str, access_token: &str) -> Result<ZedFetchBundle, String> {`;
  rustAccount = replaceOnce(
    rustAccount,
    fetchSignature,
    `fn is_zed_student_plan(user_raw: &Value) -> bool {\n    let direct_plan = pick_first_string(&[\n        json_nested_str(user_raw, &["plan", "plan_v3"]),\n        json_nested_str(user_raw, &["plan", "plan"]),\n    ]);\n    if direct_plan\n        .as_deref()\n        .map(|plan| plan.eq_ignore_ascii_case("zed_student"))\n        .unwrap_or(false)\n    {\n        return true;\n    }\n\n    let Some(organization_id) =\n        json_nested_str(user_raw, &["default_organization_id"])\n    else {\n        return false;\n    };\n\n    json_nested_str(\n        user_raw,\n        &["plans_by_organization", organization_id.as_str()],\n    )\n    .as_deref()\n    .map(|plan| plan.eq_ignore_ascii_case("zed_student"))\n    .unwrap_or(false)\n}\n\nfn zed_token_spend_limit_reached(status: reqwest::StatusCode, body: &str) -> bool {\n    if let Ok(value) = serde_json::from_str::<Value>(body) {\n        if value\n            .get("code")\n            .and_then(Value::as_str)\n            .map(|code| code.eq_ignore_ascii_case("token_spend_limit_reached"))\n            .unwrap_or(false)\n        {\n            return true;\n        }\n        if value\n            .get("message")\n            .and_then(Value::as_str)\n            .map(|message| message.contains("Student plan credits consumed"))\n            .unwrap_or(false)\n        {\n            return true;\n        }\n    }\n\n    status == reqwest::StatusCode::PAYMENT_REQUIRED\n        || body.contains("token_spend_limit_reached")\n        || body.contains("Student plan credits consumed")\n}\n\nfn select_zed_student_probe_model(models_raw: &Value) -> Option<String> {\n    let models = models_raw.get("models")?.as_array()?;\n    let is_candidate = |model: &&Value| {\n        model.get("provider").and_then(Value::as_str) == Some("anthropic")\n            && !model\n                .get("is_disabled")\n                .and_then(Value::as_bool)\n                .unwrap_or(false)\n    };\n\n    let default_fast = models_raw\n        .get("default_fast_model")\n        .and_then(Value::as_str);\n    if let Some(default_fast) = default_fast {\n        if let Some(model) = models.iter().filter(is_candidate).find(|model| {\n            model.get("id").and_then(Value::as_str) == Some(default_fast)\n        }) {\n            return model\n                .get("id")\n                .and_then(Value::as_str)\n                .map(str::to_string);\n        }\n    }\n\n    if let Some(model) = models.iter().filter(is_candidate).find(|model| {\n        model\n            .get("id")\n            .and_then(Value::as_str)\n            .map(|id| id.to_ascii_lowercase().contains("haiku"))\n            .unwrap_or(false)\n    }) {\n        return model\n            .get("id")\n            .and_then(Value::as_str)\n            .map(str::to_string);\n    }\n\n    models\n        .iter()\n        .filter(is_candidate)\n        .find_map(|model| model.get("id").and_then(Value::as_str).map(str::to_string))\n}\n\nasync fn probe_zed_hosted_ai_availability(\n    client: &reqwest::Client,\n    authorization_header: &str,\n    user_raw: &Value,\n) -> (Option<bool>, i64) {\n    let checked_at = now_ts();\n    let Some(organization_id) =\n        json_nested_str(user_raw, &["default_organization_id"])\n    else {\n        logger::log_warn(\n            "[Zed] Student Hosted AI availability probe skipped: missing default_organization_id",\n        );\n        return (None, checked_at);\n    };\n\n    // /client/llm_tokens only proves that credentials can mint a short-lived LLM token.\n    // Student credit exhaustion is enforced later by the Hosted AI gateway, so a 200 here\n    // must never be interpreted as quota availability by itself.\n    let token_url = format!("{}/client/llm_tokens", ZED_CLOUD_BASE_URL);\n    let token_response = match client\n        .post(&token_url)\n        .header("Content-Type", "application/json")\n        .header("Authorization", authorization_header)\n        .json(&json!({ "organization_id": organization_id }))\n        .send()\n        .await\n    {\n        Ok(response) => response,\n        Err(err) => {\n            logger::log_warn(&format!(\n                "[Zed] Student Hosted AI token probe failed: {}",\n                err\n            ));\n            return (None, checked_at);\n        }\n    };\n\n    let token_status = token_response.status();\n    let token_body = match token_response.text().await {\n        Ok(body) => body,\n        Err(err) => {\n            logger::log_warn(&format!(\n                "[Zed] Student Hosted AI token response read failed: {}",\n                err\n            ));\n            return (None, checked_at);\n        }\n    };\n    if !token_status.is_success() {\n        if zed_token_spend_limit_reached(token_status, &token_body) {\n            return (Some(false), checked_at);\n        }\n        logger::log_warn(&format!(\n            "[Zed] Student Hosted AI token probe inconclusive: status={}",\n            token_status\n        ));\n        return (None, checked_at);\n    }\n\n    let llm_token = match serde_json::from_str::<Value>(&token_body)\n        .ok()\n        .and_then(|value| value.get("token").and_then(Value::as_str).map(str::to_string))\n    {\n        Some(token) if !token.trim().is_empty() => token,\n        _ => {\n            logger::log_warn(\n                "[Zed] Student Hosted AI token probe returned no usable LLM token",\n            );\n            return (None, checked_at);\n        }\n    };\n\n    // Ask the same Hosted AI gateway used by Zed which models this LLM token can access.\n    // This lets us choose a real model dynamically instead of hard-coding a model ID.\n    let models_url = format!("{}/models", ZED_CLOUD_BASE_URL);\n    let models_response = match client\n        .get(&models_url)\n        .header("Authorization", format!("Bearer {}", llm_token))\n        .header("x-zed-client-supports-x-ai", "true")\n        .send()\n        .await\n    {\n        Ok(response) => response,\n        Err(err) => {\n            logger::log_warn(&format!(\n                "[Zed] Student Hosted AI model-list probe failed: {}",\n                err\n            ));\n            return (None, checked_at);\n        }\n    };\n\n    let models_status = models_response.status();\n    let models_body = match models_response.text().await {\n        Ok(body) => body,\n        Err(err) => {\n            logger::log_warn(&format!(\n                "[Zed] Student Hosted AI model-list response read failed: {}",\n                err\n            ));\n            return (None, checked_at);\n        }\n    };\n    if !models_status.is_success() {\n        if zed_token_spend_limit_reached(models_status, &models_body)\n            || models_status == reqwest::StatusCode::FORBIDDEN\n            || models_status.as_u16() == 451\n        {\n            return (Some(false), checked_at);\n        }\n        logger::log_warn(&format!(\n            "[Zed] Student Hosted AI model-list probe inconclusive: status={}",\n            models_status\n        ));\n        return (None, checked_at);\n    }\n\n    let models_raw = match serde_json::from_str::<Value>(&models_body) {\n        Ok(value) => value,\n        Err(err) => {\n            logger::log_warn(&format!(\n                "[Zed] Student Hosted AI model-list parse failed: {}",\n                err\n            ));\n            return (None, checked_at);\n        }\n    };\n    let Some(model_id) = select_zed_student_probe_model(&models_raw) else {\n        logger::log_warn(\n            "[Zed] Student Hosted AI probe found no enabled Anthropic model",\n        );\n        return (None, checked_at);\n    };\n\n    // The Student spend limit is enforced at /completions, not while minting the LLM token.\n    // Use a one-output-token Anthropic request so a usable account incurs the smallest practical\n    // model call. An exhausted account is rejected by the gateway before upstream generation.\n    let completion_url = format!("{}/completions", ZED_CLOUD_BASE_URL);\n    let provider_request = json!({\n        "model": model_id,\n        "max_tokens": 1,\n        "messages": [{\n            "role": "user",\n            "content": [{ "type": "text", "text": "." }]\n        }],\n        "tools": [],\n        "stop_sequences": []\n    });\n    let completion_response = match client\n        .post(&completion_url)\n        .header("Content-Type", "application/json")\n        .header("Authorization", format!("Bearer {}", llm_token))\n        .header("x-zed-client-supports-status-messages", "true")\n        .header(\n            "x-zed-client-supports-stream-ended-request-completion-status",\n            "true",\n        )\n        .json(&json!({\n            "provider": "anthropic",\n            "model": model_id,\n            "provider_request": provider_request\n        }))\n        .send()\n        .await\n    {\n        Ok(response) => response,\n        Err(err) => {\n            logger::log_warn(&format!(\n                "[Zed] Student Hosted AI completion-gateway probe failed: {}",\n                err\n            ));\n            return (None, checked_at);\n        }\n    };\n\n    let completion_status = completion_response.status();\n    if completion_status.is_success() {\n        // Receiving a success response means the request passed the Student spend gate.\n        // Drop the streaming body immediately; the request itself is capped at one output token.\n        return (Some(true), checked_at);\n    }\n\n    let completion_body = completion_response.text().await.unwrap_or_default();\n    if zed_token_spend_limit_reached(completion_status, &completion_body)\n        || completion_status == reqwest::StatusCode::FORBIDDEN\n        || completion_status.as_u16() == 451\n    {\n        logger::log_warn(&format!(\n            "[Zed] Student Hosted AI unavailable: status={}, body={}",\n            completion_status,\n            completion_body\n        ));\n        return (Some(false), checked_at);\n    }\n\n    logger::log_warn(&format!(\n        "[Zed] Student Hosted AI completion-gateway probe inconclusive: status={}, body={}",\n        completion_status,\n        completion_body\n    ));\n    (None, checked_at)\n}\n\n${fetchSignature}`,
  );

  rustAccount = replaceOnce(
    rustAccount,
    `    let user_raw = fetch_json(&client, &authorization_header, "/client/users/me").await?;\n\n    Ok(ZedFetchBundle {\n`,
    `    let user_raw = fetch_json(&client, &authorization_header, "/client/users/me").await?;\n\n    let (hosted_ai_available, hosted_ai_checked_at) = if is_zed_student_plan(&user_raw) {\n        let (available, checked_at) =\n            probe_zed_hosted_ai_availability(&client, &authorization_header, &user_raw).await;\n        (available, Some(checked_at))\n    } else {\n        (None, None)\n    };\n\n    Ok(ZedFetchBundle {\n`,
  );

  rustAccount = replaceOnce(
    rustAccount,
    `        preferences_raw: json!({}),\n    })\n}\n`,
    `        preferences_raw: json!({}),\n        hosted_ai_available,\n        hosted_ai_checked_at,\n    })\n}\n`,
  );

  rustAccount = replaceOnce(
    rustAccount,
    `            token_spend_remaining_cents,\n            edit_predictions_used: pick_first_i64(&[\n`,
    `            token_spend_remaining_cents,\n            hosted_ai_available: bundle.hosted_ai_available,\n            hosted_ai_checked_at: bundle.hosted_ai_checked_at,\n            edit_predictions_used: pick_first_i64(&[\n`,
  );

  const page = readText(pagePath);
  const studentPanel = `      if (getZedPlanBadge(account) === 'STUDENT') {\n        const availabilityText =\n          account.hosted_ai_available === true\n            ? t('zed.page.hostedAiAvailable', '可用')\n            : account.hosted_ai_available === false\n              ? t('zed.page.hostedAiUnavailable', '不可用')\n              : t('zed.page.hostedAiUnknown', '未知');\n        const availabilityTone: 'high' | 'low' | 'medium' =\n          account.hosted_ai_available === true\n            ? 'high'\n            : account.hosted_ai_available === false\n              ? 'low'\n              : 'medium';\n        const checkedText = account.hosted_ai_checked_at\n          ? t('zed.page.hostedAiCheckedAt', {\n              time: formatDateTime(account.hosted_ai_checked_at, locale),\n              defaultValue: '检测时间：{{time}}',\n            })\n          : '';\n        return {\n          headline: '',\n          note: checkedText,\n          items: [\n            {\n              key: 'hosted-ai',\n              variant: 'simple',\n              label: 'Hosted AI',\n              value: availabilityText,\n              detail: '',\n              title: 'Hosted AI: ' + availabilityText,\n              tone: availabilityTone,\n            },\n          ],\n          title: checkedText\n            ? 'Hosted AI: ' + availabilityText + ' | ' + checkedText\n            : 'Hosted AI: ' + availabilityText,\n        };\n      }\n\n`;
  const patchedPage = replaceOnce(
    page,
    `      if (!hasZedQuotaData(account)) {\n`,
    studentPanel + `      if (!hasZedQuotaData(account)) {\n`,
  );

  if (!rustAccount.includes('/client/llm_tokens')) {
    throw new Error('Hosted AI LLM-token endpoint patch is missing');
  }
  if (!rustAccount.includes('"/models"')) {
    throw new Error('Hosted AI model-list endpoint patch is missing');
  }
  if (!rustAccount.includes('"/completions"')) {
    throw new Error('Hosted AI completion-gateway probe is missing');
  }
  if (!rustAccount.includes('token_spend_limit_reached')) {
    throw new Error('Student credit exhaustion classification is missing');
  }
  if (!rustAccount.includes('"max_tokens": 1')) {
    throw new Error('Student availability probe is not capped to one output token');
  }
  if (!patchedPage.includes("getZedPlanBadge(account) === 'STUDENT'")) {
    throw new Error('Student availability UI patch is missing');
  }
  if (!rustModel.includes('pub hosted_ai_available: Option<bool>')) {
    throw new Error('Rust Zed account availability field is missing');
  }
  if (!tsType.includes('hosted_ai_available?: boolean | null')) {
    throw new Error('TypeScript Zed account availability field is missing');
  }

  fs.writeFileSync(rustModelPath, rustModel);
  fs.writeFileSync(rustAccountPath, rustAccount);
  fs.writeFileSync(tsTypePath, tsType);
  fs.writeFileSync(pagePath, patchedPage);

  console.log('Applied Zed Student Hosted AI completion-gateway probe (one output token max).');
}

if (require.main === module) {
  try {
    applyZedStudentAvailability(path.resolve(process.argv[2]));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

module.exports = { applyZedStudentAvailability, replaceOnce };

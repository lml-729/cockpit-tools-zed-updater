use serde_json::{json, Value};
const ZED_CLOUD_BASE_URL: &str = "https://cloud.zed.dev";
mod logger {
    pub fn log_warn(message: &str) {
        eprintln!("{}", message);
    }
}
fn now_ts() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs() as i64
}
fn json_nested_str(value: &Value, path: &[&str]) -> Option<String> {
    let mut value = value;
    for key in path {
        value = value.get(*key)?;
    }
    value.as_str().map(str::to_owned)
}
fn pick_first_string(values: &[Option<String>]) -> Option<String> {
    values.iter().flatten().next().cloned()
}
include!("../../zed-student-hosted-ai.rs");

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut args = std::env::args().skip(1);
    let input = args
        .next()
        .ok_or("Usage: zed-hosted-ai-probe ACCOUNT_FILE EXPECTED_USER_ID [REPORT_FILE]")?;
    let expected_id = args.next().ok_or("Expected user ID required")?;
    let report_file = args.next();
    if input != "-" {
        if let Some(file) = report_file
            .as_ref()
            .filter(|file| std::path::Path::new(file).exists())
        {
            if std::fs::canonicalize(file)? == std::fs::canonicalize(&input)? {
                return Err("Report must not overwrite the account export".into());
            }
        }
    }
    let mut bytes = if input == "-" {
        let mut line = String::new();
        std::io::stdin().read_line(&mut line)?;
        line.into_bytes()
    } else {
        std::fs::read(input)?
    };
    if bytes.starts_with(&[0xef, 0xbb, 0xbf]) {
        bytes.drain(..3);
    }
    let document: Value = serde_json::from_slice(&bytes)?;
    let account = if let Some(accounts) = document.get("accounts").and_then(Value::as_array) {
        accounts
            .iter()
            .find(|a| a.get("user_id").and_then(Value::as_str) == Some(&expected_id))
            .ok_or("Account not found")?
    } else {
        &document
    };
    let user_id = account
        .get("user_id")
        .and_then(Value::as_str)
        .ok_or("Missing user ID")?;
    if user_id != expected_id {
        return Err("Account does not match the requested test user".into());
    }
    let token = account
        .get("access_token")
        .and_then(Value::as_str)
        .ok_or("Missing token")?;
    let auth = format!("{} {}", user_id, token);
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()?;
    let response = client
        .get(format!("{}/client/users/me", ZED_CLOUD_BASE_URL))
        .header("Authorization", &auth)
        .send()
        .await;
    let mut report = json!({"account_id": format!("zed_{}", user_id), "tested_at": now_ts(),
        "probe_version": 2, "available": null, "reason": "unknown"});
    match response {
        Ok(response) => {
            let status = response.status().as_u16();
            report["identity_http_status"] = json!(status);
            if (200..300).contains(&status) {
                if let Ok(user) = response.json::<Value>().await {
                    let actual = user
                        .pointer("/user/legacy_user_id")
                        .or_else(|| user.pointer("/user/id"));
                    let matched = actual.is_some_and(|id| {
                        id.as_i64()
                            .map(|id| id.to_string())
                            .or_else(|| id.as_str().map(str::to_owned))
                            .as_deref()
                            == Some(user_id)
                    });
                    report["identity_matched"] = json!(matched);
                    if matched && is_zed_student_plan(&user) {
                        let (available, checked_at, reason) =
                            probe_zed_hosted_ai_availability(&client, &auth, &user).await;
                        report["available"] = json!(available);
                        report["checked_at"] = json!(checked_at);
                        report["reason"] = json!(reason);
                    }
                }
            }
        }
        Err(_) => {
            report["transport_failed"] = json!(true);
        }
    }
    let serialized = serde_json::to_string_pretty(&report)?;
    if let Some(file) = report_file {
        std::fs::write(file, &serialized)?;
    }
    println!("{}", serialized);
    Ok(())
}

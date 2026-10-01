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
    `fn is_zed_student_plan(user_raw: &Value) -> bool {\n    let direct_plan = pick_first_string(&[\n        json_nested_str(user_raw, &["plan", "plan_v3"]),\n        json_nested_str(user_raw, &["plan", "plan"]),\n    ]);\n    if direct_plan\n        .as_deref()\n        .map(|plan| plan.eq_ignore_ascii_case("zed_student"))\n        .unwrap_or(false)\n    {\n        return true;\n    }\n\n    let Some(organization_id) =\n        json_nested_str(user_raw, &["default_organization_id"])\n    else {\n        return false;\n    };\n\n    json_nested_str(\n        user_raw,\n        &["plans_by_organization", organization_id.as_str()],\n    )\n    .as_deref()\n    .map(|plan| plan.eq_ignore_ascii_case("zed_student"))\n    .unwrap_or(false)\n}\n\nasync fn probe_zed_hosted_ai_availability(\n    client: &reqwest::Client,\n    authorization_header: &str,\n    user_raw: &Value,\n) -> (Option<bool>, i64) {\n    let checked_at = now_ts();\n    let Some(organization_id) =\n        json_nested_str(user_raw, &["default_organization_id"])\n    else {\n        logger::log_warn(\n            "[Zed] Student Hosted AI availability probe skipped: missing default_organization_id",\n        );\n        return (None, checked_at);\n    };\n\n    let url = format!("{}/client/llm_tokens", ZED_CLOUD_BASE_URL);\n    let response = client\n        .post(&url)\n        .header("Content-Type", "application/json")\n        .header("Authorization", authorization_header)\n        .json(&json!({ "organization_id": organization_id }))\n        .send()\n        .await;\n\n    match response {\n        Ok(response) if response.status().is_success() => (Some(true), checked_at),\n        Ok(response) if response.status() == reqwest::StatusCode::PAYMENT_REQUIRED => {\n            (Some(false), checked_at)\n        }\n        Ok(response) => {\n            logger::log_warn(&format!(\n                "[Zed] Student Hosted AI availability probe inconclusive: status={}",\n                response.status()\n            ));\n            (None, checked_at)\n        }\n        Err(err) => {\n            logger::log_warn(&format!(\n                "[Zed] Student Hosted AI availability probe failed: {}",\n                err\n            ));\n            (None, checked_at)\n        }\n    }\n}\n\n${fetchSignature}`,
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
    throw new Error('Hosted AI probe endpoint patch is missing');
  }
  if (rustAccount.includes('"/completions"')) {
    throw new Error('Availability patch must not send model completion requests');
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

  console.log('Applied Zed Student Hosted AI availability probe (no completion request).');
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

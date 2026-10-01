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
    `    #[serde(skip_serializing_if = "Option::is_none")]\n    pub token_spend_remaining_cents: Option<i64>,\n    #[serde(default, skip_serializing_if = "Option::is_none")]\n    pub hosted_ai_available: Option<bool>,\n    #[serde(default, skip_serializing_if = "Option::is_none")]\n    pub hosted_ai_checked_at: Option<i64>,\n    #[serde(default, skip_serializing_if = "Option::is_none")]\n    pub hosted_ai_reason: Option<String>,\n    #[serde(default, skip_serializing_if = "Option::is_none")]\n    pub hosted_ai_probe_version: Option<u32>,\n`,
  );

  let tsType = readText(tsTypePath);
  tsType = replaceOnce(
    tsType,
    `  token_spend_remaining_cents?: number | null;\n`,
    `  token_spend_remaining_cents?: number | null;\n  hosted_ai_available?: boolean | null;\n  hosted_ai_checked_at?: number | null;\n  hosted_ai_reason?: string | null;\n  hosted_ai_probe_version?: number | null;\n`,
  );

  let rustAccount = readText(rustAccountPath);
  rustAccount = replaceOnce(
    rustAccount,
    `    preferences_raw: Value,\n}\n`,
    `    preferences_raw: Value,\n    hosted_ai_available: Option<bool>,\n    hosted_ai_checked_at: Option<i64>,\n    hosted_ai_reason: Option<String>,\n    hosted_ai_probe_version: Option<u32>,\n}\n`,
  );

  const fetchSignature = `async fn fetch_remote_bundle(user_id: &str, access_token: &str) -> Result<ZedFetchBundle, String> {`;
  rustAccount = replaceOnce(
    rustAccount,
    fetchSignature,
    `include!("zed_student_hosted_ai.rs");\n\n${fetchSignature}`,
  );

  rustAccount = replaceOnce(
    rustAccount,
    `    let user_raw = fetch_json(&client, &authorization_header, "/client/users/me").await?;\n\n    Ok(ZedFetchBundle {\n`,
    `    let user_raw = fetch_json(&client, &authorization_header, "/client/users/me").await?;\n\n    let (hosted_ai_available, hosted_ai_checked_at, hosted_ai_reason, hosted_ai_probe_version) = if is_zed_student_plan(&user_raw) {\n        let (available, checked_at, reason) =\n            probe_zed_hosted_ai_availability(&client, &authorization_header, &user_raw).await;\n        (available, Some(checked_at), Some(reason.to_string()), Some(2))\n    } else {\n        (None, None, None, None)\n    };\n\n    Ok(ZedFetchBundle {\n`,
  );

  rustAccount = replaceOnce(
    rustAccount,
    `        preferences_raw: json!({}),\n    })\n}\n`,
    `        preferences_raw: json!({}),\n        hosted_ai_available,\n        hosted_ai_checked_at,\n        hosted_ai_reason,\n        hosted_ai_probe_version,\n    })\n}\n`,
  );

  rustAccount = replaceOnce(
    rustAccount,
    `            token_spend_remaining_cents,\n            edit_predictions_used: pick_first_i64(&[\n`,
    `            token_spend_remaining_cents,\n            hosted_ai_available: bundle.hosted_ai_available,\n            hosted_ai_checked_at: bundle.hosted_ai_checked_at,\n            hosted_ai_reason: bundle.hosted_ai_reason,\n            hosted_ai_probe_version: bundle.hosted_ai_probe_version,\n            edit_predictions_used: pick_first_i64(&[\n`,
  );

  const page = readText(pagePath);
  const studentPanel = `      if (getZedPlanBadge(account) === 'STUDENT') {
        // Older builds only checked token issuance; their cached true is unverified.
        const verified = account.hosted_ai_probe_version === 2;
        const available = verified ? account.hosted_ai_available : null;
        const reason = verified ? account.hosted_ai_reason : null;
        const availabilityText = !verified
          ? t('zed.page.hostedAiNeedsRefresh', '待检测，请刷新')
          : reason === 'quota_exhausted'
            ? t('zed.page.hostedAiQuotaExhausted', 'Student 额度已用完')
            : reason === 'permission_denied'
              ? t('zed.page.hostedAiPermissionDenied', '权限不足')
              : reason === 'authentication_failed'
                ? t('zed.page.hostedAiAuthenticationFailed', '登录凭证失效')
                : reason === 'payment_required'
                  ? t('zed.page.hostedAiPaymentRequired', '付款限制')
                  : reason === 'rate_limited'
                    ? t('zed.page.hostedAiRateLimited', '暂时限流，请稍后刷新')
                    : available === true
                      ? t('zed.page.hostedAiAvailable', '可用')
                      : available === false
                        ? t('zed.page.hostedAiUnavailable', '不可用')
                        : t('zed.page.hostedAiUnknown', '检测失败，请刷新');
        const availabilityTone: 'high' | 'low' | 'medium' =
          available === true ? 'high' : available === false ? 'low' : 'medium';
        const checkedText = verified && account.hosted_ai_checked_at
          ? t('zed.page.hostedAiCheckedAt', {
              time: formatDateTime(account.hosted_ai_checked_at, locale),
              defaultValue: '检测时间：{{time}}',
            })
          : '';
        return {
          headline: '',
          note: checkedText,
          items: [{
            key: 'hosted-ai', variant: 'simple', label: 'Hosted AI',
            value: availabilityText, detail: '',
            title: 'Hosted AI: ' + availabilityText, tone: availabilityTone,
          }],
          title: checkedText
            ? 'Hosted AI: ' + availabilityText + ' | ' + checkedText
            : 'Hosted AI: ' + availabilityText,
        };
      }

`;

  const patchedPage = replaceOnce(
    page,
    `      if (!hasZedQuotaData(account)) {\n`,
    studentPanel + `      if (!hasZedQuotaData(account)) {\n`,
  );

  const probe = readText(path.join(__dirname, 'zed-student-hosted-ai.rs'));
  for (const marker of ['/client/llm_tokens', '/models', '/completions',
    'token_spend_limit_reached', '"max_tokens": 1', 'stream_ended']) {
    if (!probe.includes(marker)) throw new Error('Hosted AI probe missing: ' + marker);
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

  // Imported snapshots cannot establish the current account's ability to generate.
  rustAccount = replaceOnce(rustAccount, '    for stored in accounts {\n',
    `    for mut stored in accounts {
        stored.public_account.hosted_ai_available = None;
        stored.public_account.hosted_ai_checked_at = None;
        stored.public_account.hosted_ai_reason = None;
        stored.public_account.hosted_ai_probe_version = None;
`);
  rustAccount = replaceOnce(rustAccount,
    '    stored.public_account.quota_query_last_error = message;\n',
    `    if message.is_some() {
        stored.public_account.hosted_ai_available = None;
        stored.public_account.hosted_ai_reason = Some("unknown".to_string());
        stored.public_account.hosted_ai_checked_at = Some(now_ts());
        stored.public_account.hosted_ai_probe_version = Some(2);
    }
    stored.public_account.quota_query_last_error = message;
`);

  fs.writeFileSync(path.join(root, 'src-tauri/src/modules/zed_student_hosted_ai.rs'), probe);
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

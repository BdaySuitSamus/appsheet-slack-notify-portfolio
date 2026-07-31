/**
 * AppSheet -> Slack DM webhook receiver.
 *
 * Deployed as a Web App (doPost). Called as a new step appended to an
 * existing AppSheet automation bot, right after its existing email step.
 * Every path below returns HTTP 200 -- this must never be the reason the
 * bot itself shows a failure, since the email step has already run by the
 * time this fires.
 *
 * Secrets (WEBHOOK_SHARED_SECRET, SLACK_BOT_TOKEN_BRAND_A,
 * SLACK_BOT_TOKEN_BRAND_B) live in this script's Script Properties
 * (Project Settings > Script Properties), not in this file. See
 * config.example.json in the repo root for the values to set.
 */

// Recipient email domain -> which workspace's bot token to use. Chosen
// over the source app's free-text "Brand" field after finding that field
// blank on ~40% of real rows in practice, with inconsistent casing and
// spelling on the rest -- the resolved recipient email domain proved far
// more reliable, since it's backed by the same lookup table the existing
// email step already depends on.
const DOMAIN_TOKEN_PROPERTY = {
  'brand-a.example.com': 'SLACK_BOT_TOKEN_BRAND_A',
  'brand-b.example.com': 'SLACK_BOT_TOKEN_BRAND_B',
};

function doPost(e) {
  try {
    return handleWebhook(e);
  } catch (err) {
    console.error('Unhandled error in doPost: ' + err);
    return jsonResponse({ ok: false, reason: 'unhandled_error' });
  }
}

function handleWebhook(e) {
  const props = PropertiesService.getScriptProperties();
  const expectedSecret = props.getProperty('WEBHOOK_SHARED_SECRET');

  const body = parseBody(e);
  const providedSecret = body.secret;

  if (!expectedSecret || providedSecret !== expectedSecret) {
    console.warn('Rejected webhook call: bad or missing shared secret.');
    return jsonResponse({ ok: false, reason: 'unauthorized' });
  }

  const recipientEmail = (body.recipientEmail || '').trim();
  if (!recipientEmail || recipientEmail.indexOf('@') === -1) {
    console.log('Skipping Slack DM: no resolvable recipient email. PackageID=' + body.packageId);
    return jsonResponse({ ok: true, skipped: 'no_recipient_email' });
  }

  const domain = recipientEmail.split('@')[1].toLowerCase();
  const tokenPropertyName = DOMAIN_TOKEN_PROPERTY[domain];
  if (!tokenPropertyName) {
    console.log('Skipping Slack DM: domain "' + domain + '" not in the routing map. PackageID=' + body.packageId);
    return jsonResponse({ ok: true, skipped: 'unmapped_domain', domain: domain });
  }

  const slackToken = props.getProperty(tokenPropertyName);
  if (!slackToken) {
    console.error('Missing Script Property "' + tokenPropertyName + '" for domain "' + domain + '".');
    return jsonResponse({ ok: false, reason: 'missing_slack_token', domain: domain });
  }

  const userId = lookupSlackUserId(recipientEmail, slackToken);
  if (!userId) {
    console.log('Skipping Slack DM: no Slack user found for ' + recipientEmail);
    return jsonResponse({ ok: true, skipped: 'user_not_found', domain: domain });
  }

  const message = buildMessage(body);
  const posted = postSlackDM(userId, message, slackToken);

  return jsonResponse({ ok: true, sent: posted, domain: domain });
}

function parseBody(e) {
  if (!e || !e.postData || !e.postData.contents) return {};
  try {
    return JSON.parse(e.postData.contents);
  } catch (err) {
    console.warn('Could not parse JSON body: ' + err);
    return {};
  }
}

function buildMessage(body) {
  const recipientName = body.recipientName ? body.recipientName.split(' ')[0] : 'Hi';
  const tracking = body.trackingNumber ? ' (tracking #' + body.trackingNumber + ')' : '';
  const carrierPart = body.carrier ? ' from ' + body.carrier + tracking : '';
  return "*You've got mail* 📦\n" + recipientName + ', a package' +
    carrierPart + ' just arrived for you at the office. Check your email for the full notification.';
}

function lookupSlackUserId(email, token) {
  const resp = UrlFetchApp.fetch(
    'https://slack.com/api/users.lookupByEmail?email=' + encodeURIComponent(email),
    {
      headers: { Authorization: 'Bearer ' + token },
      muteHttpExceptions: true,
    }
  );
  const data = JSON.parse(resp.getContentText());
  if (!data.ok) {
    console.log('users.lookupByEmail failed for ' + email + ': ' + data.error);
    return null;
  }
  return data.user.id;
}

function postSlackDM(userId, text, token) {
  const resp = UrlFetchApp.fetch('https://slack.com/api/chat.postMessage', {
    method: 'post',
    contentType: 'application/json; charset=utf-8',
    headers: { Authorization: 'Bearer ' + token },
    payload: JSON.stringify({ channel: userId, text: text }),
    muteHttpExceptions: true,
  });
  const data = JSON.parse(resp.getContentText());
  if (!data.ok) {
    console.error('chat.postMessage failed for user ' + userId + ': ' + data.error);
    return false;
  }
  return true;
}

function jsonResponse(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

/**
 * Manual test harness -- run from the Apps Script editor (Run menu) to
 * exercise handleWebhook() with a fake payload before wiring the real bot.
 * Requires WEBHOOK_SHARED_SECRET and at least one SLACK_BOT_TOKEN_* Script
 * Property to already be set (Project Settings > Script Properties).
 * Replace the recipientEmail below with a real throwaway test address
 * before running -- a real Slack DM will be sent if it resolves.
 */
function test_doPost_manual() {
  const secret = PropertiesService.getScriptProperties().getProperty('WEBHOOK_SHARED_SECRET');
  const fakeEvent = {
    postData: {
      contents: JSON.stringify({
        secret: secret,
        recipientEmail: 'REPLACE_WITH_TEST_EMAIL@brand-a.example.com',
        recipientName: 'Test Recipient',
        carrier: 'UPS Ground',
        trackingNumber: '1Z_TEST_1234',
        packageId: 'test-manual-run',
      }),
    },
  };
  const result = doPost(fakeEvent);
  console.log(result.getContent());
}

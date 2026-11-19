import pg from "pg";

const { Pool } = pg;

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL
});

pool.on("error", (err) => {
  console.error("Unexpected idle PostgreSQL client error:", err);
});

export async function initDb() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS community_leads (
        id SERIAL PRIMARY KEY,
        slack_user_id TEXT UNIQUE NOT NULL,
        display_name TEXT,
        email TEXT,
        company_domain TEXT,
        company_title TEXT,
        github_username TEXT,
        fit_score INTEGER,
        ai_analysis JSONB,
        sent_to_slack BOOLEAN NOT NULL DEFAULT FALSE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS redressal_tickets (
        id SERIAL PRIMARY KEY,
        slack_user_id TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        message_ts TEXT UNIQUE NOT NULL,
        original_text TEXT NOT NULL,
        category TEXT,
        urgency TEXT,
        summary TEXT,
        suggested_reply TEXT,
        status TEXT NOT NULL DEFAULT 'OPEN',
        resolved_by TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        resolved_at TIMESTAMPTZ
      );
    `);
  } finally {
    client.release();
  }
}

export async function saveLeadAnalysis({
  slackUserId,
  displayName,
  email,
  companyDomain,
  companyTitle,
  githubUsername,
  fitScore,
  aiAnalysis
}) {
  const query = `
    INSERT INTO community_leads (
      slack_user_id,
      display_name,
      email,
      company_domain,
      company_title,
      github_username,
      fit_score,
      ai_analysis,
      sent_to_slack
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, FALSE)
    ON CONFLICT (slack_user_id)
    DO UPDATE SET
      display_name = EXCLUDED.display_name,
      email = EXCLUDED.email,
      company_domain = EXCLUDED.company_domain,
      company_title = EXCLUDED.company_title,
      github_username = EXCLUDED.github_username,
      fit_score = EXCLUDED.fit_score,
      ai_analysis = EXCLUDED.ai_analysis,
      updated_at = NOW()
    RETURNING *;
  `;

  const values = [
    slackUserId,
    displayName,
    email,
    companyDomain,
    companyTitle,
    githubUsername,
    fitScore,
    JSON.stringify(aiAnalysis)
  ];

  const { rows } = await pool.query(query, values);
  return rows[0];
}

export async function markLeadSentToSlack(slackUserId) {
  const query = `
    UPDATE community_leads
    SET sent_to_slack = TRUE, updated_at = NOW()
    WHERE slack_user_id = $1
    RETURNING id, slack_user_id, sent_to_slack;
  `;
  const { rows } = await pool.query(query, [slackUserId]);
  return rows[0];
}

export async function createRedressalTicket({
  slackUserId,
  channelId,
  messageTs,
  originalText,
  category,
  urgency,
  summary,
  suggestedReply
}) {
  const query = `
    INSERT INTO redressal_tickets (
      slack_user_id,
      channel_id,
      message_ts,
      original_text,
      category,
      urgency,
      summary,
      suggested_reply
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    ON CONFLICT (message_ts) DO NOTHING
    RETURNING id;
  `;

  const values = [
    slackUserId,
    channelId,
    messageTs,
    originalText,
    category,
    urgency,
    summary,
    suggestedReply
  ];

  const { rows } = await pool.query(query, values);
  return rows[0]?.id || null;
}

export async function resolveRedressalTicket(ticketId, resolvedBy) {
  const query = `
    UPDATE redressal_tickets
    SET status = 'RESOLVED', resolved_by = $2, resolved_at = NOW()
    WHERE id = $1
    RETURNING id, status, resolved_by;
  `;
  const { rows } = await pool.query(query, [ticketId, resolvedBy]);
  return rows[0];
}
export async function getLeadBySlackUserId(slackUserId) {
  const query = `
    SELECT slack_user_id, display_name, company_domain, github_username, fit_score
    FROM community_leads
    WHERE slack_user_id = $1
    LIMIT 1;
  `;
  const { rows } = await pool.query(query, [slackUserId]);
  return rows[0] || null;
}
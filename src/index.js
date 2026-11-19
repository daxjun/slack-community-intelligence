import "dotenv/config";
import express from "express";
import bolt from "@slack/bolt";
import {
  initDb,
  saveLeadAnalysis,
  markLeadSentToSlack,
  getLeadBySlackUserId,
  createRedressalTicket,
  resolveRedressalTicket
} from "./db.js";
import { enrichMemberProfile } from "./services/research.js";
import { analyzeMemberLead } from "./services/ai.js";
import { classifyRedressalMessage } from "./services/redressalAi.js";

const activeUsers = new Set();
const processedMessages = new Set();
const { App } = bolt;

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

app.get("/health", (req, res) => {
  res.status(200).json({
    status: "healthy",
    message: "Slack AI Agent is running"
  });
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});

const slackApp = new App({
  token: process.env.SLACK_BOT_TOKEN,
  appToken: process.env.SLACK_APP_TOKEN,
  socketMode: true
});

function buildLeadReportBlocks({
  slackUserId,
  displayName,
  email,
  companyDomain,
  companyTitle,
  githubUsername,
  githubUrl,
  analysis
}) {
  const githubText = githubUsername
    ? githubUrl
      ? `<${githubUrl}|${githubUsername}>`
      : githubUsername
    : "Not found";

  const recommendationsText = analysis.recommendations
    .map((rec, idx) => `${idx + 1}. ${rec}`)
    .join("\n");

  return [
    {
      type: "header",
      text: {
        type: "plain_text",
        text: `New Community Lead Report (Fit Score: ${analysis.fit_score}/100)`
      }
    },
    {
      type: "section",
      fields: [
        { type: "mrkdwn", text: `*Member:*\n<@${slackUserId}> (${displayName})` },
        { type: "mrkdwn", text: `*Email:*\n${email || "Not available"}` },
        { type: "mrkdwn", text: `*Company Domain:*\n${companyDomain || "None"}` },
        { type: "mrkdwn", text: `*GitHub:*\n${githubText}` }
      ]
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Website Title:* ${companyTitle || "N/A"}\n\n*Behavioral Insights:*\n${analysis.behavioral_insights}`
      }
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Recommended Next Actions:*\n${recommendationsText}`
      }
    }
  ];
}

function buildRedressalBlocks({
  ticketId,
  slackUserId,
  channelId,
  messageTs,
  originalText,
  triage,
  leadProfile,
  effectiveUrgency
}) {
  const isHighValue =
    leadProfile && (leadProfile.fit_score >= 70 || Boolean(leadProfile.company_domain));

  const accountContext = leadProfile
    ? `Fit Score: *${leadProfile.fit_score}/100* | Domain: *${leadProfile.company_domain || "None"}* | GitHub: *${leadProfile.github_username || "None"}*`
    : "No prior lead profile recorded";

  const alertBanner = isHighValue
    ? "High-Value Account Alert — Prioritize for Churn Prevention / Expansion"
    : "Standard Community Support Ticket";

  const actionPayload = JSON.stringify({
    ticketId,
    channelId,
    messageTs,
    suggestedReply: triage.suggested_reply
  });

  return [
    {
      type: "header",
      text: {
        type: "plain_text",
        text: `Redressal Ticket #${ticketId} [${effectiveUrgency.toUpperCase()} - ${triage.category}]`
      }
    },
    {
      type: "section",
      fields: [
        { type: "mrkdwn", text: `*Member:*\n<@${slackUserId}>` },
        { type: "mrkdwn", text: `*Channel:*\n<#${channelId}>` },
        { type: "mrkdwn", text: `*Account Intelligence:*\n${accountContext}` },
        { type: "mrkdwn", text: `*Priority Signal:*\n${alertBanner}` }
      ]
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Issue Summary:* ${triage.summary}\n*Original Message:*\n>${originalText.replace(/\n/g, "\n>")}`
      }
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*AI Suggested Reply:*\n\`\`\`${triage.suggested_reply}\`\`\``
      }
    },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "Post AI Reply in Thread" },
          style: "primary",
          action_id: "send_ai_reply",
          value: actionPayload
        },
        {
          type: "button",
          text: { type: "plain_text", text: "Mark Resolved" },
          action_id: "resolve_ticket",
          value: actionPayload
        }
      ]
    }
  ];
}

async function processNewMember(slackUserId, client) {
  if (!slackUserId || activeUsers.has(slackUserId)) return;
  activeUsers.add(slackUserId);

  try {
    const userInfo = await client.users.info({ user: slackUserId });
    const user = userInfo.user;

    if (!user || user.is_bot || user.deleted || slackUserId === "USLACKBOT") {
      console.log(`Skipping bot/system user: ${slackUserId}`);
      return;
    }

    const displayName =
      user.profile?.display_name ||
      user.profile?.real_name ||
      user.real_name ||
      user.name ||
      "Unknown Member";
    const email = user.profile?.email || null;

    console.log(`Processing lead for ${displayName} (${slackUserId})...`);

    const enrichment = await enrichMemberProfile({ email, displayName });

    const analysis = await analyzeMemberLead({
      slackUserId,
      displayName,
      email,
      companyDomain: enrichment.companyDomain,
      companyTitle: enrichment.companyTitle,
      githubUsername: enrichment.githubUsername
    });

    await saveLeadAnalysis({
      slackUserId,
      displayName,
      email,
      companyDomain: enrichment.companyDomain,
      companyTitle: enrichment.companyTitle,
      githubUsername: enrichment.githubUsername,
      fitScore: analysis.fit_score,
      aiAnalysis: analysis
    });

    console.log(`Saved lead analysis to PostgreSQL for ${slackUserId} (score: ${analysis.fit_score})`);

    const reportChannelId = process.env.SLACK_REPORT_CHANNEL_ID;
    if (!reportChannelId) {
      console.warn("SLACK_REPORT_CHANNEL_ID is not set; skipping Slack report post.");
      return;
    }

    await client.chat.postMessage({
      channel: reportChannelId,
      text: `New Community Lead: ${displayName} (Fit Score: ${analysis.fit_score}/100)`,
      blocks: buildLeadReportBlocks({
        slackUserId,
        displayName,
        email,
        companyDomain: enrichment.companyDomain,
        companyTitle: enrichment.companyTitle,
        githubUsername: enrichment.githubUsername,
        githubUrl: enrichment.githubUrl,
        analysis
      })
    });

    await markLeadSentToSlack(slackUserId);
    console.log(`Posted lead report to Slack channel ${reportChannelId} for ${slackUserId}`);
  } catch (err) {
    console.error(`Failed processing member ${slackUserId}:`, err);
  } finally {
    activeUsers.delete(slackUserId);
  }
}

slackApp.event("team_join", async ({ event, client }) => {
  const userId = typeof event.user === "string" ? event.user : event.user?.id;
  await processNewMember(userId, client);
});

slackApp.event("member_joined_channel", async ({ event, client }) => {
  await processNewMember(event.user, client);
});

slackApp.message(async ({ message, client }) => {
  // Ignore bot messages, edits, deletions, and messages inside the admin report channel itself
  if (message.subtype || message.bot_id || !message.text || !message.user) return;
  if (message.channel === process.env.SLACK_REPORT_CHANNEL_ID) return;
  if (processedMessages.has(message.ts)) return;
  processedMessages.add(message.ts);

  try {
    const triage = await classifyRedressalMessage({
      channelId: message.channel,
      slackUserId: message.user,
      messageText: message.text
    });

    if (!triage.is_issue) {
      return;
    }

    const leadProfile = await getLeadBySlackUserId(message.user);
    const isHighValue =
      leadProfile && (leadProfile.fit_score >= 70 || Boolean(leadProfile.company_domain));

    const effectiveUrgency =
      isHighValue && (triage.urgency === "Low" || triage.urgency === "Medium")
        ? "High"
        : triage.urgency;

    const ticketId = await createRedressalTicket({
      slackUserId: message.user,
      channelId: message.channel,
      messageTs: message.ts,
      originalText: message.text,
      category: triage.category,
      urgency: effectiveUrgency,
      summary: triage.summary,
      suggestedReply: triage.suggested_reply
    });

    if (!ticketId) return;

    console.log(`Created redressal ticket #${ticketId} (${effectiveUrgency}) for ${message.user}`);

    const reportChannelId = process.env.SLACK_REPORT_CHANNEL_ID;
    if (!reportChannelId) return;

    await client.chat.postMessage({
      channel: reportChannelId,
      text: `Redressal Ticket #${ticketId} [${effectiveUrgency}]: ${triage.summary}`,
      blocks: buildRedressalBlocks({
        ticketId,
        slackUserId: message.user,
        channelId: message.channel,
        messageTs: message.ts,
        originalText: message.text,
        triage,
        leadProfile,
        effectiveUrgency
      })
    });
  } catch (err) {
    console.error("Failed processing redressal message:", err);
  }
});

slackApp.action("send_ai_reply", async ({ ack, body, client }) => {
  await ack();

  try {
    const payload = JSON.parse(body.actions[0].value);
    await client.chat.postMessage({
      channel: payload.channelId,
      thread_ts: payload.messageTs,
      text: payload.suggestedReply
    });

    await client.chat.postMessage({
      channel: body.channel.id,
      thread_ts: body.message.ts,
      text: `Posted AI reply in <#${payload.channelId}> (triggered by <@${body.user.id}>).`
    });
  } catch (err) {
    console.error("Failed posting AI reply:", err);
  }
});

slackApp.action("resolve_ticket", async ({ ack, body, client }) => {
  await ack();

  try {
    const payload = JSON.parse(body.actions[0].value);
    await resolveRedressalTicket(payload.ticketId, body.user.id);

    await client.chat.update({
      channel: body.channel.id,
      ts: body.message.ts,
      text: `Ticket #${payload.ticketId} resolved by <@${body.user.id}>`,
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `*Redressal Ticket #${payload.ticketId} — RESOLVED*\nClosed by <@${body.user.id}>.`
          }
        }
      ]
    });

    console.log(`Ticket #${payload.ticketId} marked RESOLVED by ${body.user.id}`);
  } catch (err) {
    console.error("Failed resolving ticket:", err);
  }
});

await initDb();
console.log("PostgreSQL connected and tables ready!");

await slackApp.start();
console.log("Slack Bolt app is connected!");
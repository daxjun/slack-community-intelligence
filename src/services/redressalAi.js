import { ChatPromptTemplate } from "@langchain/core/prompts";
import { ChatOpenAI } from "@langchain/openai";

const triagePrompt = ChatPromptTemplate.fromMessages([
  [
    "system",
    `You are a community support and redressal triage AI. Analyze a Slack message and decide if it is an actionable support issue, bug report, access problem, or complaint that needs admin redressal.
Ignore casual greetings, jokes, general discussion, or "thank you" messages by setting "is_issue": false.

Respond ONLY with valid JSON in this exact shape:
{{
  "is_issue": <boolean>,
  "category": "<Bug | Account/Access | Onboarding | Complaint | Question>",
  "urgency": "<Low | Medium | High | Critical>",
  "summary": "<1 concise sentence summarizing the problem>",
  "suggested_reply": "<polite, helpful 1-2 sentence reply an admin can send to resolve or acknowledge the issue>"
}}`
  ],
  [
    "human",
    `Channel ID: {channelId}
User ID: {slackUserId}
Message: {messageText}`
  ]
]);

function getGroqModel() {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) throw new Error("Missing GROQ_API_KEY in .env");

  return new ChatOpenAI({
    model: process.env.GROQ_MODEL || "openai/gpt-oss-20b",
    temperature: 0.2,
    apiKey,
    configuration: {
      baseURL: "https://api.groq.com/openai/v1"
    },
    modelKwargs: {
      response_format: { type: "json_object" }
    }
  });
}

export async function classifyRedressalMessage({ channelId, slackUserId, messageText }) {
  const model = getGroqModel();
  const chain = triagePrompt.pipe(model);

  const response = await chain.invoke({
    channelId,
    slackUserId,
    messageText
  });

  const raw =
    typeof response.content === "string"
      ? response.content
      : Array.isArray(response.content)
        ? response.content.map((p) => (typeof p === "string" ? p : p?.text || "")).join("")
        : "";

  const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();

  try {
    const parsed = JSON.parse(cleaned);
    return {
      is_issue: Boolean(parsed.is_issue),
      category: parsed.category || "Question",
      urgency: parsed.urgency || "Medium",
      summary: parsed.summary || messageText.slice(0, 120),
      suggested_reply:
        parsed.suggested_reply || "Thanks for flagging this! Our team is looking into it now."
    };
  } catch {
    return {
      is_issue: false,
      category: "Question",
      urgency: "Low",
      summary: "",
      suggested_reply: ""
    };
  }
}
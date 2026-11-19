# Autonomous Slack Community Intelligence & Redressal Agent

An event-driven AI agent built with **Node.js**, **Slack Bolt (Socket Mode)**, **LangChain**, **Groq API**, and **PostgreSQL** that automates community lead qualification and real-time support triage.

## Core Capabilities

1. **Automated Lead Discovery & Enrichment**
   - Listens to `team_join` and `member_joined_channel` events with concurrency-safe duplicate filtering (`Set` idempotency guards).
   - Extracts non-free email domains, fetches company website metadata, and resolves GitHub profiles.
   - Evaluates member fit (`0–100` score), behavioral insights, and onboarding actions via Groq (`json_object` structured output).
   - Persists enriched records in PostgreSQL (`community_leads`) prior to posting Block Kit report cards to a private admin channel.

2. **Cross-Referenced Issue Triage & Redressal**
   - Monitors public support channels (`message.channels`) and filters out casual conversation (`is_issue: false`).
   - Classifies bug reports, access issues, and complaints by category and urgency, drafting a tailored response.
   - Cross-references the sender's stored `community_leads` profile to automatically escalate urgency for high-fit or enterprise-domain members (`fit_score >= 70`), supporting churn prevention and account expansion.

3. **Human-in-the-Loop Interactive Resolution**
   - **Post AI Reply in Thread:** Posts the LLM-drafted troubleshooting response directly into the original Slack message thread (`thread_ts`).
   - **Mark Resolved:** Updates the admin Block Kit card in place (`chat.update`) and marks the ticket `RESOLVED` in PostgreSQL (`redressal_tickets`) with audit metadata (`resolved_by`, `resolved_at`).

## Architecture & Tech Stack

- **Runtime & Server:** Node.js (ES Modules), Express (`/health` endpoint)
- **Slack Integration:** `@slack/bolt` (Socket Mode, Events API, Block Kit Interactivity)
- **AI Orchestration:** LangChain (`@langchain/core`, `@langchain/openai`) + Groq Cloud (`openai/gpt-oss-20b`)
- **Database:** PostgreSQL (`pg` connection pool, Docker)

## Project Structure

```text
src/
├── index.js                  # Express server, Slack Bolt listeners, and interactive action handlers
├── db.js                     # PostgreSQL pool, schema initialization, lead & ticket queries
└── services/
    ├── research.js           # Company domain & GitHub profile enrichment
    ├── ai.js                 # Structured LLM lead scoring & onboarding analysis
    └── redressalAi.js        # Structured LLM issue triage & reply drafting
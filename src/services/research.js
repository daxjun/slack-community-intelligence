import axios from "axios";

const FREE_EMAIL_DOMAINS = new Set([
  "gmail.com",
  "googlemail.com",
  "yahoo.com",
  "outlook.com",
  "hotmail.com",
  "live.com",
  "icloud.com",
  "proton.me",
  "protonmail.com",
  "aol.com"
]);

export function extractCompanyDomain(email) {
  if (!email || typeof email !== "string" || !email.includes("@")) {
    return null;
  }

  const domain = email.split("@")[1].trim().toLowerCase();
  if (!domain || FREE_EMAIL_DOMAINS.has(domain)) {
    return null;
  }

  return domain;
}

export async function scrapeWebsiteTitle(domain) {
  if (!domain) return null;

  const url = domain.startsWith("http") ? domain : `https://${domain}`;

  try {
    const response = await axios.get(url, {
      timeout: 5000,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
      }
    });

    const html = typeof response.data === "string" ? response.data : "";
    const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    if (!match || !match[1]) {
      return null;
    }

    return match[1].replace(/\s+/g, " ").trim();
  } catch (err) {
    console.warn(`Website scrape failed for ${domain}:`, err.message);
    return null;
  }
}

export async function findGitHubUser({ email, nameOrHandle }) {
  const queryTerm = email || nameOrHandle;
  if (!queryTerm) return null;

  const headers = {
    Accept: "application/vnd.github+json",
    "User-Agent": "slack-community-intelligence-agent"
  };

  if (process.env.GITHUB_TOKEN) {
    headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  }

  try {
    const response = await axios.get("https://api.github.com/search/users", {
      params: { q: queryTerm, per_page: 1 },
      timeout: 5000,
      headers
    });

    const topUser = response.data?.items?.[0];
    if (!topUser) return null;

    return {
      login: topUser.login,
      profileUrl: topUser.html_url
    };
  } catch (err) {
    console.warn(`GitHub lookup failed for ${queryTerm}:`, err.message);
    return null;
  }
}

export async function enrichMemberProfile({ email, displayName }) {
  const companyDomain = extractCompanyDomain(email);

  const [companyTitle, githubUser] = await Promise.all([
    scrapeWebsiteTitle(companyDomain),
    findGitHubUser({ email, nameOrHandle: displayName })
  ]);

  return {
    companyDomain,
    companyTitle,
    githubUsername: githubUser ? githubUser.login : null,
    githubUrl: githubUser ? githubUser.profileUrl : null
  };
}

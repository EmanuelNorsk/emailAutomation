import dotenv from "dotenv";
import { readFile } from "node:fs/promises";
import readline from "node:readline/promises";
import { google } from "googleapis";
import { stdin as input, stdout as output } from "node:process";
import { writeFile } from "node:fs/promises";
import { access } from "node:fs/promises";
import OpenAI from "openai";

import type { Credentials as Tokens } from "google-auth-library";
import type { gmail_v1 } from "googleapis";


// Imports and basic setup for the script
dotenv.config({ path: ".env.local" });
const apiKeyRegex = /^sk-proj-[a-zA-Z0-9_-]+$/;
const googleCredentialsPath: string = "credentials.json";
const scopes = [
    "https://www.googleapis.com/auth/gmail.modify",
    "https://www.googleapis.com/auth/gmail.labels",
];

type Credentials = {
    "client_id": string, 
    "project_id": string,
    "auth_uri": string,
    "token_uri": string,
    "auth_provider_x509_cert_url": string,
    "client_secret": string,
    "redirect_uris": string[]
}

type GoogleCredentials = {
    installed: Credentials
}

type ParsedEmail = {
  sentAt: string | null;
  from: string | null;
  subject: string | null;
  body: string;
  id: string;
};

type LabelConfig = Record<string, string>;
type LabelMap = Map<string, string>;
type GmailLabelMap = Map<string, string>;

function checkOpenAIAPIKey(key: string | undefined) : void {
    if (!key) {
        console.error("Error: OPENAI_API_KEY is not defined in the environment variables.");
        process.exit(1);
    }
    if (!apiKeyRegex.test(key)) {
        console.error("Error: OPENAI_API_KEY is not in the correct format.");
        process.exit(1);
    }
    console.log("OPENAI_API_KEY is valid.");
}

function checkGoogleAPICredentials(credentials: GoogleCredentials) : void {
    const requiredFields: (keyof Credentials)[] = ["client_id", "project_id", "auth_uri", "token_uri", "auth_provider_x509_cert_url", "client_secret", "redirect_uris"];
    const creds = credentials.installed;

    for (const field of requiredFields) {
        if (!creds[field]) {
            console.error(`Error: Google API credentials are missing the required field: ${field}`);
            process.exit(1);
        }
    }
    console.log("Google API credentials are valid.");
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function getHeader(headers: gmail_v1.Schema$MessagePartHeader[] | undefined, name: string): string | null {
  return headers?.find((header) => header.name?.toLowerCase() === name.toLowerCase())?.value ?? null;
}

function decodeBase64Url(data: string | null | undefined): string {
  if (!data) return "";

  const normalized = data.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(normalized, "base64").toString("utf8");
}

function extractBody(part: gmail_v1.Schema$MessagePart | undefined): string {
  if (!part) return "";

  if (part.mimeType === "text/plain" && part.body?.data) {
    return decodeBase64Url(part.body.data);
  }

  if (part.parts?.length) {
    for (const child of part.parts) {
      const body = extractBody(child);
      if (body) return body;
    }
  }

  if (part.body?.data) {
    return decodeBase64Url(part.body.data);
  }

  return "";
}

function parseMessage(message: gmail_v1.Schema$Message): ParsedEmail {
  const payload = message.payload;
  const headers = payload?.headers;

  const sentAt = getHeader(headers, "Date");
  const from = getHeader(headers, "From");
  const subject = getHeader(headers, "Subject");
  const body = extractBody(payload).trim();

  return {
    sentAt,
    from,
    subject,
    body,
    id: message.id!
  };
}

async function ensureLabelsExist(labels: LabelConfig, gmail: gmail_v1.Gmail): Promise<LabelMap> {
    const response = await gmail.users.labels.list({ userId: "me" });
    const existingLabels = response.data.labels ?? [];
    const existingLabelNames = new Set(existingLabels.map(label => label.name));

    const labelMap: LabelMap = new Map<string, string>();

    for (const label of existingLabels) {
        if (label.name && label.id) {
            labelMap.set(label.name, label.id);
        }
    }


    for (const labelName of Object.keys(labels)) {
        if (!existingLabelNames.has(labelName)) {
            const label: gmail_v1.Schema$Label = await gmail.users.labels.create({
                userId: "me",
                requestBody: {
                    name: labelName,
                    messageListVisibility: "show",
                    labelListVisibility: "labelShow",
                },
            });

            if (label.name && label.id) {   
                labelMap.set(label.name, label.id);
            }

            console.log(`Label "${labelName}" was created successfully.`);
        }
    }

    return labelMap
}

async function applyCategoryToMessage(
  gmail: gmail_v1.Gmail,
  email: ParsedEmail,
  category: string,
  labelMap: LabelMap,
  debug: boolean = false
): Promise<void> {
    const messageID = email.id;
    const gmailLabelName = `AI/${category}`;
    const labelID = labelMap.get(gmailLabelName);

    if (!labelID) {
        throw new Error(`Missing Gmail label for category: ${gmailLabelName}`);
    }

    await gmail.users.messages.modify({
        userId: "me",
        id: messageID,
        requestBody: {
            addLabelIds: [labelID],
            removeLabelIds: [],
        }
    });

    if (debug) {
        console.log(`Applied label "${gmailLabelName}" to message with ID: ${messageID}`);
    }
}

async function getMessages(gmail: gmail_v1.Gmail, messagesInParallel: number = 3): Promise<ParsedEmail[]> {
    const res = await gmail.users.messages.list({
        userId: "me",
        q: "has:nouserlabels",
        maxResults: messagesInParallel,
    });

    const messages = res.data.messages ?? [];
    const parsedMessages: ParsedEmail[] = [];

    for (const message of messages) {
        if (!message.id) continue;

        const messageResponse = await gmail.users.messages.get({
            userId: "me",
            id: message.id,
            format: "full",
        });

        parsedMessages.push(parseMessage(messageResponse.data));
    }

    return parsedMessages;
}

async function evaluateCategory(client: OpenAI, email: ParsedEmail, labels: LabelConfig): Promise<string> {
    const response = await client.responses.create({
        model: "gpt-5.4-mini",
        input: `You are a Gmail assistant that helps categorize emails based on their content. You have the following labels available: ${Object.keys(labels).map((label) => label.replace(/^AI\//, "")).join(", ")}.

        Given the following email, determine which single label from the list would be most appropriate for categorizing it. 
        Only respond with the name of the label that best fits the email content. 
        Do not provide any explanations or additional text. The email is as follows:
        Title: ${email?.subject ?? "Test Title"}
        From: ${email?.from ?? "Test From"}
        Date: ${email?.sentAt ?? "Test Date"}
        Body: ${email?.body ?? "If you read this then put this in the other label"}
        `,
    });

    return response.output_text
}

async function categorizeEmails(client: OpenAI, gmail: gmail_v1.Gmail, labelMap: LabelMap, labels: LabelConfig): Promise<void> {
    const messages = await getMessages(gmail);

    await Promise.all(
        messages.map(async (email) => {

            const category = (await evaluateCategory(client, email, labels)).trim().toLowerCase();
            await applyCategoryToMessage(gmail, email, category, labelMap);
        })
    )
}

async function mainLoop(client: OpenAI, gmail: gmail_v1.Gmail, labelMap: LabelMap, labels: LabelConfig, sleepMs: number): Promise<void> {
    while (true) {
        try {
            await categorizeEmails(client, gmail, labelMap, labels);
        } catch (error) {
            console.error("Error during categorization loop:", error);
        }

        await new Promise((resolve) => setTimeout(resolve, sleepMs));
    }
}

async function main() {
    // Init
    const labels: LabelConfig = JSON.parse(await readFile("labels.json", "utf-8"));

    const openAIAPIKey: string | undefined = process.env.OPENAI_API_KEY;
    checkOpenAIAPIKey(openAIAPIKey);

    const googleCredentials: GoogleCredentials = JSON.parse(await readFile(googleCredentialsPath, "utf-8"));
    checkGoogleAPICredentials(googleCredentials);

    const oauth2Client = new google.auth.OAuth2({
        clientId: googleCredentials.installed.client_id,
        clientSecret: googleCredentials.installed.client_secret,
        redirectUri: googleCredentials.installed.redirect_uris[0],
    });

    if (!await fileExists("tokens.json")) {

        const authUrl = oauth2Client.generateAuthUrl({
            access_type: "offline",
            scope: scopes,
            prompt: "consent",
        });

        console.log("Open this URL in your browser:");
        console.log(authUrl);

        const rl = readline.createInterface({ input, output });
        const code = await rl.question("Paste the Google code here: ");
        rl.close();

        const newTokens = await oauth2Client.getToken(code.trim());
        await writeFile("tokens.json", JSON.stringify(newTokens.tokens, null, 2), "utf8");
        console.log("Saved token.json");
    }

    const tokens: Tokens = JSON.parse(await readFile("tokens.json", "utf-8"));
    oauth2Client.setCredentials(tokens);
    
    const gmail = google.gmail({ version: "v1", auth: oauth2Client });
    const labelMap: LabelMap = await ensureLabelsExist(labels, gmail);

    const client = new OpenAI({
        apiKey: openAIAPIKey,
    });

    mainLoop(client, gmail, labelMap, labels, 3 * 1000);
    
}

main().catch((error) => {
    console.error("An error occurred:", error);
    process.exit(1);
});
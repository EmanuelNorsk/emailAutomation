# Email Automation

A small TypeScript project that uses Gmail and OpenAI to automatically sort emails into custom Gmail labels.

The current version:

- reads emails from Gmail
- creates any missing custom labels from `labels.json`
- sends email content to OpenAI for classification
- applies the selected Gmail label to the message

## How It Works

1. The app connects to your Gmail account with Google OAuth.
2. It loads your custom categories from `labels.json`.
3. It fetches emails that do not already have user labels.
4. It asks OpenAI to choose the best matching category.
5. It applies the corresponding Gmail label.

## Tech Stack

- TypeScript
- Gmail API
- OpenAI API
- `dotenv` for local environment variables

## Setup

### 1. Install dependencies

```bash
npm install
```

If `tsx` is not available in your environment, install it:

```bash
npm install -D tsx typescript @types/node
```

### 2. Create your local environment file

Create `.env.local`:

```env
OPENAI_API_KEY=your_openai_api_key_here
```

Do not commit this file.

### 3. Add your Google OAuth credentials

Put your real Google OAuth desktop client credentials in:

```text
credentials.json
```

A safe example structure is included in:

```text
credentials-example.json
```

Do not commit your real `credentials.json`.

### 4. Configure your labels

Edit `labels.json` and define the labels you want to use.

Example:

```json
{
  "AI/work": "Work-related emails",
  "AI/personal": "Personal emails",
  "AI/urgent": "Emails that require immediate attention"
}
```

### 5. Run the script

```bash
npx tsx script.ts
```

On first run, Google OAuth will ask you to sign in and grant Gmail access. The app will save local tokens for future runs.

## Important Files

- `script.ts`: main app logic
- `labels.json`: your label definitions
- `.env.local`: local OpenAI key
- `credentials.json`: local Google OAuth credentials
- `tokens.json`: saved Google OAuth tokens

## Security

These files should stay local and should not be pushed to GitHub:

- `.env.local`
- `credentials.json`
- `tokens.json`
- `token.json`

Use `.gitignore` to keep them out of version control.

## Status

This project is still an early local prototype. It is meant for experimenting with AI-based Gmail sorting, not production use yet.

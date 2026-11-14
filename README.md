# AI Bridge Demo

A small local experiment that controls a visible browser with Playwright and sends prompts to Gemini, ChatGPT, or Claude.

## Requirements
- Node.js 18+
- Accounts that can access the AI services you want to use
- On Windows, Microsoft Edge or Google Chrome set as the default browser

## Run
```bash
npm install
npm start
```

Open http://localhost:3000 and choose Gemini, ChatGPT, or Claude; Gemini is selected by default. Clicking a provider button navigates the AI Bridge browser to that service, and the next prompt is sent there. The first selection opens the selected service in the default Edge or Chrome using the persistent AI Bridge profile. If Windows has no supported default-browser setting, the bridge uses Chrome.

On Windows, sign in to each service in the AI Bridge browser window when prompted; sign-ins are saved under `%LOCALAPPDATA%\AI-Bridge`. Your regular browser profile remains separate. If Claude displays a security verification challenge, complete it manually in the AI Bridge browser and retry; the bridge does not bypass verification. Gemini, ChatGPT, and Claude may change their page structure or automation policies, so browser selectors may need updates.

To explicitly use Edge instead, set `AI_BRIDGE_BROWSER=msedge` before starting the bridge. Use `AI_BRIDGE_BROWSER=chrome` to explicitly select Chrome.
On non-Windows systems, install Playwright's Chromium browser with `npx playwright install chromium`.

## Notes
- This is a fragile learning demo, not an official integration with any provider.
- Provider websites may change their DOM, so the selectors in `server.js` may need updating using browser DevTools.
- Keep the browser visible. Do not store or share browser profiles/cookies.
- Use only in ways permitted by Google's terms and policies. Do not bypass CAPTCHA, login controls, or anti-bot protections.
- Only one request is processed at a time in this demo.

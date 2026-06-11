# BettaDayz RP — BettaBukz Edition v1

This repository contains two parts:

1. **Full local game** — Node.js, WebSockets, SQLite, Electron desktop, Android/iOS Capacitor setup.
2. **GitHub Pages website v1** — static landing page, static catalog preview, and lightweight web demo in `/site`.

## Website v1

The GitHub Pages website lives in:

```text
site/
```

Pages included:

```text
site/index.html        # Landing page
site/play-demo.html    # Static playable demo
site/catalog.html      # Static catalog preview
site/setup.html        # Setup instructions
```

## Deploy to GitHub Pages

This repo includes:

```text
.github/workflows/deploy-pages.yml
```

On GitHub:

1. Go to **Settings → Pages**.
2. Set **Source** to **GitHub Actions**.
3. Push to `main`.
4. Open the Pages URL shown in the workflow or repository Pages settings.

## Push first version to GitHub

```bash
git init
git add .
git commit -m "BettaDayz RP v1 BettaBukz website and game"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/bettadayz-rp.git
git push -u origin main
```

## Run full game locally

```bash
npm install
cp .env.example .env
npm run local
```

Open:

```text
http://localhost:3000
```

## Important

GitHub Pages is for the static website and static demo. The full multiplayer game backend needs Node.js hosting, local development, or another server platform.

## Deployment Notes (added)

- Live site: https://skebbanhb-ai.github.io/bettadayz-rp/

- This repository's GitHub Actions workflow deploys the `public/` folder to Pages. To update the published site, modify files under `public/` and push to `main`.

- Key files:
	- `.github/workflows/deploy-pages.yml` — Pages workflow
	- `public/` — published static site files (index.html, assets, styles)
	- `public/style.css` — site styles (your CSS edits were added here)

- Common commands:

```bash
# Commit and push updates
git add public
git commit -m "Update site"
git push origin main

# Rerun Pages workflow (if needed) — requires GitHub CLI
gh run list --repo skebbanhb-ai/bettadayz-rp
gh run rerun <run-id> --repo skebbanhb-ai/bettadayz-rp
```

- Troubleshooting:
	- Ensure Pages is enabled in the repo Settings → Pages and set to build with GitHub Actions.
	- Check Actions → Deploy to GitHub Pages for workflow logs.
	- If deployment fails due to action deprecations, update action versions in `.github/workflows/deploy-pages.yml`.

If you want, I can also add a short CONTRIBUTING section or a badge for the Pages site.

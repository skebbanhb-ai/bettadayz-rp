# GitHub Pages Setup

## 1. Create a GitHub repository

Suggested repo name:

```text
bettadayz-rp
```

## 2. Push this folder

```bash
git init
git add .
git commit -m "BettaDayz RP v1"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/bettadayz-rp.git
git push -u origin main
```

## 3. Enable Pages

Go to:

```text
GitHub repository → Settings → Pages → Build and deployment → Source → GitHub Actions
```

## 4. Wait for deployment

Open:

```text
GitHub repository → Actions → Deploy BettaDayz Website to GitHub Pages
```

## 5. Your website URL

For a project page, the URL usually looks like:

```text
https://YOUR_USERNAME.github.io/bettadayz-rp/
```

## 6. What is deployed

The workflow deploys only:

```text
site/
```

The full Node.js game remains in the repository for local/desktop/mobile builds.

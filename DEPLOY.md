# Getting Gym Tracker onto your phone

This turns the app into something you tap from your Home Screen like any other app — no App Store, no laptop needed once it's set up. It works by putting the code on GitHub, having GitHub host it as a website (GitHub Pages), then installing that website as an app via Safari.

Read the **Two things that will bite you** section before you install — both are one-time gotchas that are easy to avoid and annoying to recover from if you don't.

---

## 0. Before you start

You need a free [GitHub](https://github.com) account and `git` installed. Check with:

```bash
git --version
```

If that prints a version, you're set. If not, install it from [git-scm.com](https://git-scm.com/downloads).

**A note on where this folder lives:** it's currently inside iCloud Drive. Git works fine there, but iCloud can occasionally evict file contents to save space or drop placeholder files into a synced folder, which looks like file corruption to git. If `git status` ever shows files you didn't touch, or `git add` complains about unreadable files, that's why — the fix is moving the project to a non-iCloud folder (e.g. `~/Developer/`). Not a problem to pre-solve, just something to recognize if it happens.

---

## 1. Turn this folder into a git repository

From the project folder (the one with `index.html` in it):

```bash
git init
git add .
git commit -m "Gym Tracker"
```

## 2. Create the GitHub repo and push

**Option A — on github.com:** go to [github.com/new](https://github.com/new), name it (e.g. `gym-tracker`), leave it **public** (Pages needs a public repo unless you're on a paid plan), don't initialize it with a README, then click **Create repository**. It'll show you commands — use the "…or push an existing repository" block, which looks like:

```bash
git remote add origin https://github.com/YOUR_USERNAME/gym-tracker.git
git branch -M main
git push -u origin main
```

**Option B — with the `gh` CLI**, if you have it installed:

```bash
gh repo create gym-tracker --public --source=. --push
```

## 3. Turn on GitHub Pages

1. On your repo's GitHub page, click **Settings** (top right of the repo, not your account settings).
2. Click **Pages** in the left sidebar.
3. Under **Source**, choose **Deploy from a branch**.
4. Branch: **main**, folder: **/ (root)**. Click **Save**.
5. Wait about a minute, then refresh the page — a box near the top will show your live URL: `https://YOUR_USERNAME.github.io/gym-tracker/`.

Open that URL in any browser first to confirm it loads before moving to your phone.

## 4. Install it on your phone

Must be done in **Safari** on iOS — Chrome/Firefox on iOS can't install home-screen apps, they're all just Safari underneath but only Safari itself gets that button.

1. Open your GitHub Pages URL in Safari.
2. Tap the **Share** icon (square with an arrow, bottom of the screen).
3. Scroll down and tap **Add to Home Screen**.
4. Tap **Add**.

An icon now sits on your Home Screen and opens full-screen, no browser bar, exactly like a native app.

---

## Two things that will bite you

**1. Add to Home Screen *before* you log a single set.** iOS gives a home-screen app its own storage, completely separate from Safari's. If you use the app in a regular Safari tab first — log workouts, build templates — none of it carries over once you install it. Install first, use it only through the icon from then on.

**2. This is also why installing matters, not just convenience:** Safari tabs are subject to iOS clearing site data after about a week of inactivity. A home-screen app is exempt from that. If you ever find yourself using this through a Safari tab instead of the icon, your history is one quiet phone-storage-cleanup away from disappearing.

---

## Shipping updates later

Whenever you (or I) change the code:

```bash
git add .
git commit -m "describe the change"
git push
```

GitHub Pages redeploys automatically, usually within a minute.

The app caches itself for offline use, which means **the phone won't see the update immediately** — it's still showing what it already downloaded. Fully close the app (swipe it away in the app switcher) and reopen it, twice if the first reopen doesn't show the change. That's normal for any offline-capable app, not a bug.

## If something goes wrong

- **Blank page or old version after an update** — force-close and reopen the app (see above). If that doesn't work, delete the icon and re-add it from Safari.
- **Pages shows a 404** — double check Settings → Pages says the source is `main` / `/ (root)`, and that `index.html` is at the top level of the repo, not inside a subfolder.
- **Icon doesn't look right on the Home Screen** — this can lag behind an update by a launch or two while iOS's own icon cache catches up; not worth chasing unless it's still wrong after a day.

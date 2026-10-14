# JEC Lost & Found — Plan

A campus lost-and-found portal for **Jabalpur Engineering College (JEC), Jabalpur**,
built and maintained by the **Department of Mechatronics Engineering**.

## 1. Goals

1. Anyone in college can **report a lost item** (with photos) and everyone gets to see it.
2. Anyone who **finds something** can post it (with photos) and say where it can be collected
   (from them, or deposited at a department / office).
3. The owner and the finder get **connected automatically**: their phone numbers are exchanged
   only after the owner/finder confirms the match (numbers are never public).
4. Everyone can be **notified** of new posts (browser / phone push notifications).
5. Tickets **close themselves** after a fixed number of days, and can be closed by the person who
   posted them or by an admin.
6. Simple enough that a department can run it on one small server with no paid services.

## 2. Users and roles

| Role | Can do |
|------|--------|
| Visitor (not signed in) | Browse and search all open posts. |
| Member (student / staff, signed in) | Post lost / found items, respond to posts, accept / reject responses, close / extend own posts, get notifications. |
| Admin (Mechatronics dept. coordinators) | Everything above + close / reopen / delete any post, ban users, reset passwords, promote admins, edit collection points. |

Sign-up asks for: name, mobile number, college ID / enrollment no., department, password.
Mobile number is the login. (No SMS / e-mail needed — an admin can reset a forgotten password.)

## 3. Core flows

### A. "I lost something"
1. Member posts a **Lost** ticket: title, category, description, where / when lost, up to 4 photos.
2. Every subscribed device gets a push notification: _"Lost: Blue HP calculator near Library"_.
3. Someone who has it opens the ticket → **"I found this"** → adds a note (+ optional photo, where it is now).
4. The owner is notified, reviews the response and taps **"Yes, that's mine"** → both now see each
   other's mobile number (with one-tap Call / WhatsApp). Or **"Not mine"** to reject.
5. After getting it back the owner marks the ticket **Returned** (resolved).

### B. "I found something"
1. Member posts a **Found** ticket with photos and **handover**: _"Contact me"_ or _"Deposited at …"_
   (collection points like Mechatronics Dept. office, Student Section, Library counter — admin-editable).
2. Optional **secret detail** (e.g. "wallpaper is a cat", "₹200 inside") visible only to the finder and
   admins — used to verify the real owner.
3. Owner opens it → **"This is mine"** → describes proof.
4. Finder reviews → accepts → numbers exchanged / owner told to collect from the deposit point.
5. Finder marks **Returned**.

### C. Ticket lifecycle

```
open ──(owner/finder marks returned)──▶ resolved
  │──(poster closes / admin closes)────▶ closed
  └──(expiry date passes)──────────────▶ expired
```

* Lost tickets expire after **15 days**, found tickets after **30 days** (configurable).
* 2 days before expiry the poster gets a reminder and can **extend** (max 2 times).
* Admin can **reopen** anything.

## 4. Notifications

* **Web Push** (works on Android / desktop browsers, and on iPhone when the site is added to the
  Home Screen). Users choose: _all new posts_ or _only things about my posts_.
* **In-site bell**: personal notifications (someone responded, response accepted, ticket expiring…).
* **Share to WhatsApp** button on every post, so it can be forwarded to class groups.

## 5. Tech choices

| Piece | Choice | Why |
|-------|--------|-----|
| Server | Node.js 22 + Express | Simple, one process, runs anywhere. |
| Pages | Server-rendered EJS + a little vanilla JS | Fast on cheap phones, no build step. |
| Database | SQLite (built into Node 22, one file) | No database server or account needed; easy backup (copy one folder). |
| Photos | Stored on disk in `data/uploads`, compressed in the browser before upload | Saves mobile data and server space. |
| Push | `web-push` with auto-generated VAPID keys | Free, no Firebase account. |
| Auth | Mobile + password (bcrypt), DB-backed sessions, CSRF tokens | No third-party login needed. |

Everything the app stores lives in **one folder (`data/`)** → back it up and you have everything.

## 6. Deployment options

1. **College / department server or any VPS** (recommended): `docker compose up -d` or `npm start` behind Nginx with HTTPS.
2. **Railway / Render / Fly.io**: use the Dockerfile and attach a persistent volume at `/app/data`.

HTTPS is required for push notifications (localhost is fine for testing).

## 7. Future ideas

* College-email OTP or Google sign-in restricted to the college domain.
* E-mail / SMS notifications.
* Image-based matching between lost and found posts.
* Monthly report of returned items for the department notice board.

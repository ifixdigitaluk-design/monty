# Run Monty on a free Oracle Cloud VM

This is about 30–45 minutes the first time. You need:

- An Oracle Cloud account. It asks for a card to verify identity; Always Free resources aren't charged.
- A Gmail **app password**.
- A free **DuckDNS** subdomain.

## 1. Create the server
1. **Create the instance.** In the Oracle Cloud console, go to **Compute → Instances → Create instance**.
   - **Image:** *Canonical Ubuntu 24.04*.
   - **Shape:** *Ampere* `VM.Standard.A1.Flex` with 2 OCPU and 12 GB memory, which is within Always Free. If Ampere capacity is unavailable in your region, try again later or pick another availability domain.
   - **SSH key:** under *Add SSH keys*, download the generated private key (or paste your own public key).
   - Create the instance, then note its **public IP address**.
2. **Open web ports.** Open the instance's **Virtual cloud network → Security Lists → Default security list → Add ingress rules**:
   - Source `0.0.0.0/0`, TCP, destination port `80`.
   - Source `0.0.0.0/0`, TCP, destination port `443`.

## 2. Point a free address at it
1. Sign in at https://www.duckdns.org and add a subdomain, e.g. `yourteam-monty`.
2. Set its IP to the server's public IP. The install script also keeps it updated if you give it your DuckDNS token.

## 3. Gmail app password
1. Google Account → **Security**: turn on **2-Step Verification**.
2. Google Account → **Security → App passwords**: create one named "Monty". Copy the 16 letters. You'll type them into the server in step 4; don't paste them into chats or tickets.

Gmail sends up to about 500 recipients a day, and emails come from your Gmail address.

## 3b. Google sign-in (optional, free)
1. Go to <https://console.cloud.google.com/> → create a project (e.g. "Monty").
2. **APIs & Services → OAuth consent screen**: choose **Internal** if your staff use Google Workspace (only your organisation can sign in), otherwise **External** and add your staff as test users.
3. **APIs & Services → Credentials → Create credentials → OAuth client ID** → type **Web application**.
4. Under **Authorised redirect URIs** add exactly: `https://YOUR-ADDRESS/api/v1/auth/google/callback` (your Monty address from step 2).
5. Copy the **client ID** and **client secret**; the installer asks for them. Never paste the secret in chat or email.

How it behaves:
- A Google account whose email matches an existing Monty account is linked to it.
- New people get an account only if invite-only mode allows it (first account, or a pending invitation).
- Two-step verification still applies.
- People who only use Google have no password. To set one (needed to turn on two-step verification or delete their account), they use **Forgot password**.
- **The Windows app** shows Monty inside an embedded browser, and Google often blocks sign-in there. In the app, use email and password, or sign in through a normal browser.

## 4. Install
```bash
ssh -i <your-key> ubuntu@<public-ip>
sudo apt-get update && sudo apt-get install -y git
git clone https://github.com/ifixdigitaluk-design/monty.git
cd monty
sudo bash infra/oracle/install.sh
```
The script:
- Installs Docker.
- Opens the server firewall.
- Asks for your address, Gmail and app password.
- Generates every other secret into `infra/docker/.env`. That file is readable by root only.
- Builds and starts Monty with automatic HTTPS.
- Schedules nightly database backups.

The first build takes about 10 minutes on the free VM.

## 5. First sign-in
1. Open `https://yourteam-monty.duckdns.org` and **create your account**. In invite-only mode the very first account doesn't need an invitation.
2. Confirm your email from the message Monty sends.
3. Create your team organisation, then **Members & settings → Invitations** to invite staff. Only invited addresses can sign up.
4. Recommended: **Sessions & security → Set up two-factor**.

## Everyday operations
| Task | Command (on the server, in `~/monty`) |
|---|---|
| Update to the latest version | `sudo bash infra/oracle/update.sh` (backs up first) |
| See status | `sudo docker compose --env-file infra/docker/.env -f compose.yaml -f infra/oracle/compose.oracle.yaml ps` |
| Logs | add `logs -f api` (or `web`, `caddy`) to the command above |
| Backup now | `sudo bash infra/oracle/backup.sh` (files in `/var/backups/monty`) |
| Restore drill | `infra/scripts/backup-restore-drill.sh`; see docs/RUNBOOKS.md §4 |

**Keep copies off the server.** A dead VM takes its local backups with it. Copy `/var/backups/monty` somewhere else regularly, for example Oracle Object Storage (Always Free includes 20 GB) or your own computer with `scp`.

## Downloads page and Windows app (GitHub)
1. In the GitHub repo, go to **Settings → Secrets and variables → Actions → Variables → New variable**: `MONTY_URL` = `https://yourteam-monty.duckdns.org`.
2. Go to **Settings → Pages → Source: GitHub Actions**. Then **Actions → Download site → Run workflow**. Your page appears at `https://<owner>.github.io/monty/`.
3. Go to **Actions → Desktop (Windows) → Run workflow** and enter a version such as `0.2.0`. When it finishes, the installer is on the repo's **Releases** page, and the download page links to it.

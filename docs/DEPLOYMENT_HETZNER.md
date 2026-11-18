# Deploying to a Hetzner Cloud VPS

Runbook for moving the agent off a laptop onto a small always-on Linux box, so the 9am drafter fires whether or not your Mac is awake. Written for Hetzner Cloud but any Ubuntu VPS with Docker works the same way.

## Who does what

| Step | Owner | Notes |
|------|-------|-------|
| 1. Sign up at hetzner.com/cloud, create project `nanoclaw` | You | EUR billing; roughly EUR 9-10/mo for the server. |
| 2. Generate API token (read+write) | You | Goes straight into the OneCLI vault, never into a file in this repo. |
| 3. Add SSH public key to the project | You | Generated locally, see below. |
| 4-10. Provision, bootstrap, deploy | Agent (via `hcloud` CLI + `ssh`) | |
| 11. Scan WhatsApp QR | You | Phone in hand, Linked Devices > scan. |

## Step-by-step

### 1. Hetzner sign-up
- https://www.hetzner.com/cloud
- Create account, verify email, add a payment method.
- Create a new Cloud project named `nanoclaw`.

### 2. API token
- Project > Security > API tokens > Generate. Permissions: **Read & Write**. Description: `nanoclaw-deploy`.
- Store it: `onecli vault set hetzner.api_token "<token>"`.

### 3. SSH key
```bash
ssh-keygen -t ed25519 -C "nanoclaw-deploy" -f ~/.ssh/id_ed25519_nanoclaw -N ""
cat ~/.ssh/id_ed25519_nanoclaw.pub
```
Paste the public key into Hetzner: project > Security > SSH keys > Add. Name it `deploy-key`.

### 4. Provision
Spec: **CPX21** (3 vCPU, 4 GB RAM, 80 GB NVMe, ~EUR 8.46/mo). Pick the region closest to you. Ubuntu 24.04.

```bash
hcloud server create \
  --name nanoclaw \
  --type cpx21 \
  --location ash \
  --image ubuntu-24.04 \
  --ssh-key deploy-key
```
Note the public IPv4. A domain is optional; everything below works on raw IP.

### 5. Bootstrap
```bash
ssh root@<IP>
apt update && apt -y upgrade
apt -y install ca-certificates curl gnupg git build-essential sqlite3 ufw
# Docker
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo $VERSION_CODENAME) stable" > /etc/apt/sources.list.d/docker.list
apt update && apt -y install docker-ce docker-ce-cli containerd.io docker-buildx-plugin
# Node 20
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt -y install nodejs
# Non-root user
adduser --disabled-password --gecos "" nanoclaw
usermod -aG docker nanoclaw
mkdir -p /home/nanoclaw/.ssh && cp ~/.ssh/authorized_keys /home/nanoclaw/.ssh/
chown -R nanoclaw:nanoclaw /home/nanoclaw/.ssh
# Firewall
ufw allow 22/tcp
ufw --force enable
loginctl enable-linger nanoclaw  # user systemd survives logout
```

### 6. Sync the repo
From your machine:
```bash
rsync -avz --exclude node_modules --exclude .git --exclude store --exclude logs \
  ./ nanoclaw@<IP>:/home/nanoclaw/nanoclaw/
```
On the server:
```bash
cd ~/nanoclaw
npm install
npm run build
./container/build.sh
```

### 7. Secrets
```bash
onecli vault init
onecli vault set linkedin.access_token "<token from scripts/linkedin_get_token.py>"
onecli vault set linkedin.person_urn   "urn:li:person:<id>"
```
Then write `groups/whatsapp_main/linkedin_config.json` on the server only (it is gitignored).

### 8. systemd service
`~/.config/systemd/user/nanoclaw.service`:
```ini
[Unit]
Description=NanoClaw
After=network.target

[Service]
Type=simple
WorkingDirectory=/home/nanoclaw/nanoclaw
EnvironmentFile=/home/nanoclaw/nanoclaw/.env
ExecStart=/usr/bin/node dist/index.js
Restart=on-failure

[Install]
WantedBy=default.target
```
```bash
systemctl --user daemon-reload
systemctl --user enable --now nanoclaw
journalctl --user -u nanoclaw -f
```

### 9. Pair WhatsApp
Phone > WhatsApp > Settings > Linked devices > Link a device. Scan the QR from the journalctl stream.

### 10. Re-create the scheduled task
Message the agent: "Every day at 9am, follow linkedin_workflow.md: find today's top AI and business news, draft a post, and send me the preview." It registers the cron (`0 9 * * *`, timezone from `.env`).

### 11. Verify
- Send "ping" on WhatsApp, expect a reply.
- Fire the drafter manually, reply "post it", confirm the post appears on your LinkedIn profile.
- `journalctl --user -u nanoclaw --since "10 min ago"` is clean.

## Risks to keep in mind
- **Token rotation.** If a machine that held your LinkedIn token is ever out of your control, revoke the token in the LinkedIn Developer console and rerun `scripts/linkedin_get_token.py`.
- **WhatsApp number.** If `ASSISTANT_HAS_OWN_NUMBER=true`, that SIM has to live somewhere; the default (agent runs on your own number, self-chat) needs nothing extra.
- **TLS/domain.** Not needed; nothing listens on a public port. Add a domain + Caddy only if you later expose a web UI.

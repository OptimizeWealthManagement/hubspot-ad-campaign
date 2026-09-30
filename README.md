# HubSpot ad campaign

Every hour, on the hour (Toronto time), writes the ad campaign properties onto the contacts in every
ad segment listed in `SEGMENTS` in `index.js`. The HubSpot token is `HS_AUTH_TOKEN` in the Secrets
Manager secret `hubspot-sensitive-properties-private-app-token` (ca-central-1); locally it is
`HUBSPOT_TOKEN` in `.env`.

## Run locally

```bash
npm install
node index.js
```

## Deploy

```bash
npm ci --omit=dev
cd infra/terraform && terraform init && terraform apply
```

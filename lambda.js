const { SecretsManagerClient, GetSecretValueCommand } = require("@aws-sdk/client-secrets-manager");

// Loads the HubSpot token from Secrets Manager into HUBSPOT_TOKEN, then runs the update over every segment.
exports.handler = async () => {
  if (!process.env.HUBSPOT_TOKEN) {
    const { SecretString } = await new SecretsManagerClient({}).send(
      new GetSecretValueCommand({ SecretId: process.env.HUBSPOT_SECRET_ID }),
    );
    process.env.HUBSPOT_TOKEN = JSON.parse(SecretString)[process.env.HUBSPOT_SECRET_FIELD];
  }
  const { init, SEGMENTS } = require("./index.js");
  await init(SEGMENTS);
};

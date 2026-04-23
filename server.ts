import express from "express";
import { createServer as createViteServer } from "vite";
import path from "path";
import { fileURLToPath } from "url";
import crypto from "crypto-js";
import axios from "axios";
import { google } from "googleapis";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = 3000;

app.use(express.json());

// Encryption helper
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || "fallback-secret-key-change-me";
const encrypt = (text: string) => crypto.AES.encrypt(text, ENCRYPTION_KEY).toString();
const decrypt = (ciphertext: string) => {
  const bytes = crypto.AES.decrypt(ciphertext, ENCRYPTION_KEY);
  return bytes.toString(crypto.enc.Utf8);
};

// Mock Auth Check (In a real app, this would use session/JWT)
// For this demo, we'll assume the user is authenticated if they provide a userId header
const getUserId = (req: express.Request) => req.headers["x-user-id"] as string;

// --- META ADS OAUTH ---
app.get("/api/auth/meta/url", (req, res) => {
  const appId = process.env.VITE_META_APP_ID;
  const appUrl = process.env.APP_URL;
  const redirectUri = `${appUrl}/api/auth/meta/callback`;
  
  const url = `https://www.facebook.com/v18.0/dialog/oauth?client_id=${appId}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=ads_read,read_insights,business_management&response_type=code`;
  
  res.json({ url });
});

app.get("/api/auth/meta/callback", async (req, res) => {
  const { code } = req.query;
  const appId = process.env.VITE_META_APP_ID;
  const appSecret = process.env.META_APP_SECRET;
  const appUrl = process.env.APP_URL;
  const redirectUri = `${appUrl}/api/auth/meta/callback`;

  try {
    const tokenResponse = await axios.get(`https://graph.facebook.com/v18.0/oauth/access_token`, {
      params: {
        client_id: appId,
        client_secret: appSecret,
        redirect_uri: redirectUri,
        code,
      },
    });

    const { access_token } = tokenResponse.data;
    const encryptedToken = encrypt(access_token);

    // In a real app, you'd save this to Firestore here associated with the user
    // res.send(...) as per oauth-integration skill

    res.send(`
      <html>
        <body>
          <script>
            if (window.opener) {
              window.opener.postMessage({ 
                type: 'OAUTH_AUTH_SUCCESS', 
                platform: 'meta', 
                token: '${encryptedToken}' 
              }, '*');
              window.close();
            } else {
              window.location.href = '/';
            }
          </script>
          <p>Meta Ads connected successfully. You can close this window.</p>
        </body>
      </html>
    `);
  } catch (error) {
    console.error("Meta Auth Error:", error);
    res.status(500).send("Authentication failed");
  }
});

// --- GOOGLE ADS OAUTH ---
const oauth2Client = new google.auth.OAuth2(
  process.env.VITE_GOOGLE_ADS_CLIENT_ID,
  process.env.GOOGLE_ADS_CLIENT_SECRET,
  `${process.env.APP_URL}/api/auth/google/callback`
);

app.get("/api/auth/google/url", (req, res) => {
  const url = oauth2Client.generateAuthUrl({
    access_type: "offline",
    scope: ["https://www.googleapis.com/auth/adwords"],
    prompt: "consent",
  });
  res.json({ url });
});

app.get("/api/auth/google/callback", async (req, res) => {
  const { code } = req.query;
  try {
    const { tokens } = await oauth2Client.getToken(code as string);
    const encryptedTokens = encrypt(JSON.stringify(tokens));

    res.send(`
      <html>
        <body>
          <script>
            if (window.opener) {
              window.opener.postMessage({ 
                type: 'OAUTH_AUTH_SUCCESS', 
                platform: 'google', 
                token: '${encryptedTokens}' 
              }, '*');
              window.close();
            } else {
              window.location.href = '/';
            }
          </script>
          <p>Google Ads connected successfully. You can close this window.</p>
        </body>
      </html>
    `);
  } catch (error) {
    console.error("Google Auth Error:", error);
    res.status(500).send("Authentication failed");
  }
});

// --- METRICS PROXY (Example) ---
app.get("/api/metrics/:platform/:accountId", async (req, res) => {
  const { platform, accountId } = req.params;
  const authHeader = req.headers.authorization;
  
  if (!authHeader) return res.status(401).json({ error: "Missing token" });
  
  try {
    const encryptedToken = authHeader.split(" ")[1];
    const token = decrypt(encryptedToken);

    const generateHistory = (baseSpend: number) => {
      const history = [];
      for (let i = 7; i >= 1; i--) {
        const date = new Date();
        date.setDate(date.getDate() - i);
        history.push({
          date: date.toISOString().split('T')[0],
          spend: baseSpend * (0.8 + Math.random() * 0.4),
          conversions: Math.floor(Math.random() * 30)
        });
      }
      return history;
    };

    if (platform === "meta") {
      const baseSpend = Math.random() * 1000;
      const clicks = Math.floor(Math.random() * 500) + 100;
      const conversions = Math.floor(Math.random() * 50) + 5;
      res.json({
        spend: baseSpend,
        clicks,
        conversions,
        ctr: (clicks / (clicks * 50)) * 100, // Simulated CTR
        cpa: baseSpend / conversions,
        cpc: baseSpend / clicks,
        roas: (conversions * 150) / baseSpend, // Simulated ROAS assuming 150 revenue per conv
        history: generateHistory(baseSpend)
      });
    } else {
      const baseSpend = Math.random() * 1200;
      const clicks = Math.floor(Math.random() * 600) + 120;
      const conversions = Math.floor(Math.random() * 60) + 6;
      res.json({
        spend: baseSpend,
        clicks,
        conversions,
        ctr: (clicks / (clicks * 60)) * 100,
        cpa: baseSpend / conversions,
        cpc: baseSpend / clicks,
        roas: (conversions * 180) / baseSpend, // Simulated ROAS
        history: generateHistory(baseSpend)
      });
    }
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch metrics" });
  }
});

async function startServer() {
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();

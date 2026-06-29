const API_BASE = "https://api.heygen.com";

const DEFAULT_SCRIPT = `大家好，今天给大家介绍一家本地老面店。

如果你平时喜欢吃一碗热乎、实在、有锅气的面，这家店可以试试。

我们主打现煮面条，汤底鲜香，浇头丰富，分量也很足。

中午没时间做饭，晚上想吃点舒服的，都可以来一碗。

一碗面，不只管饱，更是一天里最踏实的一口热气。

欢迎到店品尝，也可以关注我们，后面会持续分享店里的招牌面、优惠活动和真实出餐视频。`;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function requireEnv(name) {
  const value = process.env[name];
  if (!value || !value.trim()) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value.trim();
}

function optionalEnv(name) {
  const value = process.env[name];
  return value && value.trim() ? value.trim() : undefined;
}

function positiveIntEnv(name, fallback) {
  const raw = process.env[name];
  if (!raw) return fallback;

  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer. Received: ${raw}`);
  }
  return value;
}

async function parseJsonResponse(response) {
  const text = await response.text();
  let body;

  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { raw_body: text };
  }

  if (!response.ok) {
    const error = new Error(`HeyGen API request failed: ${response.status} ${response.statusText}`);
    error.detail = {
      status: response.status,
      statusText: response.statusText,
      body,
    };
    throw error;
  }

  return body;
}

async function heygenRequest(path, { apiKey, method = "GET", body } = {}) {
  const response = await fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      "X-Api-Key": apiKey,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  return parseJsonResponse(response);
}

function getItems(payload, keys) {
  for (const key of keys) {
    const value = payload?.data?.[key] ?? payload?.[key];
    if (Array.isArray(value)) return value;
  }
  return [];
}

async function chooseAvatarId(apiKey) {
  const configured = optionalEnv("HEYGEN_AVATAR_ID");
  if (configured) return configured;

  const payload = await heygenRequest("/v2/avatars", { apiKey });
  const avatars = getItems(payload, ["avatars"]);
  const candidate =
    avatars.find((avatar) => {
      const text = JSON.stringify(avatar).toLowerCase();
      return (
        (text.includes("female") || text.includes("woman")) &&
        (text.includes("business") || text.includes("professional") || text.includes("chinese"))
      );
    }) || avatars.find((avatar) => JSON.stringify(avatar).toLowerCase().includes("female")) || avatars[0];

  const avatarId = candidate?.avatar_id || candidate?.id;
  if (!avatarId) {
    const error = new Error("Could not find an available HeyGen avatar. Set HEYGEN_AVATAR_ID in GitHub Secrets.");
    error.detail = payload;
    throw error;
  }

  return avatarId;
}

async function chooseVoiceId(apiKey) {
  const configured = optionalEnv("HEYGEN_VOICE_ID");
  if (configured) return configured;

  const payload = await heygenRequest("/v2/voices", { apiKey });
  const voices = getItems(payload, ["voices"]);
  const candidate =
    voices.find((voice) => {
      const text = JSON.stringify(voice).toLowerCase();
      return (
        (text.includes("zh") || text.includes("mandarin") || text.includes("chinese")) &&
        (text.includes("female") || text.includes("woman"))
      );
    }) ||
    voices.find((voice) => {
      const text = JSON.stringify(voice).toLowerCase();
      return text.includes("zh") || text.includes("mandarin") || text.includes("chinese");
    }) ||
    voices[0];

  const voiceId = candidate?.voice_id || candidate?.id;
  if (!voiceId) {
    const error = new Error("Could not find an available HeyGen voice. Set HEYGEN_VOICE_ID in GitHub Secrets.");
    error.detail = payload;
    throw error;
  }

  return voiceId;
}

async function createVideo({ apiKey, avatarId, voiceId, script }) {
  const payload = {
    video_inputs: [
      {
        character: {
          type: "avatar",
          avatar_id: avatarId,
          avatar_style: "normal",
        },
        voice: {
          type: "text",
          input_text: script,
          voice_id: voiceId,
          speed: 1.0,
          emotion: "Friendly",
        },
        background: {
          type: "color",
          value: "#f8f3ec",
        },
      },
    ],
    dimension: {
      width: 720,
      height: 1280,
    },
    caption: true,
  };

  const result = await heygenRequest("/v2/video/generate", {
    apiKey,
    method: "POST",
    body: payload,
  });

  const videoId = result?.data?.video_id || result?.video_id;
  if (!videoId) {
    const error = new Error("HeyGen did not return a video_id.");
    error.detail = result;
    throw error;
  }

  return videoId;
}

async function getVideoStatus(apiKey, videoId) {
  return heygenRequest(`/v1/video_status.get?video_id=${encodeURIComponent(videoId)}`, { apiKey });
}

async function waitForVideo({ apiKey, videoId, timeoutMinutes, pollSeconds }) {
  const deadline = Date.now() + timeoutMinutes * 60 * 1000;

  while (Date.now() < deadline) {
    const result = await getVideoStatus(apiKey, videoId);
    const data = result?.data || result;
    const status = data?.status || "unknown";

    console.log(`video_id=${videoId} status=${status}`);

    if (status === "completed") {
      const videoUrl = data.video_url || data.url;
      if (!videoUrl) {
        const error = new Error("HeyGen status is completed, but video_url is missing.");
        error.detail = result;
        throw error;
      }
      return videoUrl;
    }

    if (status === "failed") {
      const error = new Error("HeyGen video generation failed.");
      error.detail = result;
      throw error;
    }

    await sleep(pollSeconds * 1000);
  }

  throw new Error(`Timed out after ${timeoutMinutes} minutes waiting for HeyGen video.`);
}

function writeGithubOutput(name, value) {
  const outputPath = process.env.GITHUB_OUTPUT;
  if (!outputPath) return;

  require("node:fs").appendFileSync(outputPath, `${name}=${value}\n`, "utf8");
}

async function main() {
  const apiKey = requireEnv("HEYGEN_API_KEY");
  const script = optionalEnv("VIDEO_SCRIPT") || DEFAULT_SCRIPT;
  const timeoutMinutes = positiveIntEnv("HEYGEN_TIMEOUT_MINUTES", 30);
  const pollSeconds = positiveIntEnv("HEYGEN_POLL_SECONDS", 10);

  console.log("Choosing HeyGen avatar and voice...");
  const avatarId = await chooseAvatarId(apiKey);
  const voiceId = await chooseVoiceId(apiKey);

  console.log(`avatar_id=${avatarId}`);
  console.log(`voice_id=${voiceId}`);
  console.log("Creating 9:16 Mandarin avatar video with captions...");

  const videoId = await createVideo({ apiKey, avatarId, voiceId, script });
  console.log(`video_id=${videoId}`);

  const videoUrl = await waitForVideo({
    apiKey,
    videoId,
    timeoutMinutes,
    pollSeconds,
  });

  console.log(`video_url=${videoUrl}`);
  writeGithubOutput("video_url", videoUrl);
}

main().catch((error) => {
  console.error("HeyGen video generation failed.");
  console.error(error.stack || error.message);

  if (error.detail) {
    console.error("Full error detail:");
    console.error(JSON.stringify(error.detail, null, 2));
  }

  process.exit(1);
});

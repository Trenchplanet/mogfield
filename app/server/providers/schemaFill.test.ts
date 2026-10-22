import assert from "node:assert/strict";
import { test } from "node:test";
import { contentListBody, fillBody, findVideoUrl, isContentListSchema } from "./schemaFill.js";

const values = {
  prompt: "P",
  negative: "N",
  videoUrl: "https://x/depth.mp4",
  imageUrls: ["https://x/sheet.png", "https://x/b.png"],
  quality: "720p",
  duration: 10,
  aspect: 9 / 16,
};

test("flat schema with refs, enums and limits", () => {
  const doc = {
    paths: { "/v2/models/bytedance/seedance": { post: { requestBody: { content: { "application/json": { schema: { $ref: "#/components/schemas/In" } } } } } } },
    components: {
      schemas: {
        In: {
          type: "object",
          required: ["prompt", "reference_video_url"],
          properties: {
            prompt: { type: "string" },
            negative_prompt: { type: "string" },
            reference_video_url: { type: "string" },
            reference_image_urls: { type: "array", items: { type: "string" } },
            resolution: { type: "string", enum: ["480p", "720p", "1080p"] },
            duration: { type: "integer", minimum: 4, maximum: 8 },
            aspect_ratio: { type: "string", enum: ["16:9", "9:16", "1:1"] },
            seed: { type: "integer" },
          },
        },
      },
    },
  };
  const r = fillBody(doc, values);
  assert.deepEqual(r.missing, []);
  assert.equal(r.body.prompt, "P");
  assert.equal(r.body.negative_prompt, "N");
  assert.equal(r.body.reference_video_url, "https://x/depth.mp4");
  assert.deepEqual(r.body.reference_image_urls, values.imageUrls);
  assert.equal(r.body.resolution, "720p");
  assert.equal(r.body.duration, 8); // clamped to maximum
  assert.equal(r.body.aspect_ratio, "9:16");
  assert.equal("seed" in r.body, false);
});

test("nested input/parameters shape", () => {
  const doc = {
    paths: {
      "/m": {
        post: {
          requestBody: {
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["input"],
                  properties: {
                    input: { type: "object", required: ["prompt"], properties: { prompt: { type: "string" }, images: { type: "array", items: { type: "string" } }, video: { type: "string" } } },
                    parameters: { type: "object", properties: { resolution: { type: "string", enum: ["720P", "1080P"] }, duration: { type: "integer", enum: [5, 10] } } },
                  },
                },
              },
            },
          },
        },
      },
    },
  };
  const r = fillBody(doc, values);
  assert.deepEqual(r.missing, []);
  assert.deepEqual(r.body, {
    input: { prompt: "P", images: values.imageUrls, video: "https://x/depth.mp4" },
    parameters: { resolution: "720P", duration: 10 },
  });
});

test("reports required fields it cannot fill", () => {
  const doc = { paths: { "/m": { post: { requestBody: { content: { "application/json": { schema: { type: "object", required: ["prompt", "mask_url"], properties: { prompt: { type: "string" }, mask_url: { type: "string" } } } } } } } } } };
  assert.deepEqual(fillBody(doc, values).missing, ["mask_url"]);
});

test("finds the output video", () => {
  assert.equal(findVideoUrl({ content: { video_url: "https://cdn/x?sig=1" } }), "https://cdn/x?sig=1");
  assert.equal(findVideoUrl({ data: [{ url: "https://cdn/a.png" }, { url: "https://cdn/out.mp4" }] }), "https://cdn/out.mp4");
  assert.equal(findVideoUrl({ status: "ok" }), null);
});

test("BytePlus content-list shape (Seedance 2.5)", () => {
  const doc = {
    paths: { "/v2/models/byteplus/dreamina-seedance-2-5": { post: { requestBody: { content: { "application/json": { schema: { $ref: "#/components/schemas/Req" } } } } } } },
    components: {
      schemas: {
        Req: {
          type: "object",
          required: ["content"],
          properties: {
            content: { type: "array", items: { $ref: "#/components/schemas/Item" } },
            resolution: { type: "string", enum: ["480p", "720p", "1080p", "4k"] },
            ratio: { type: "string", enum: ["16:9", "4:3", "1:1", "3:4", "9:16", "21:9", "9:21", "adaptive"] },
            duration: { type: "integer" },
            generate_audio: { type: "boolean" },
            watermark: { type: "boolean" },
          },
        },
        Item: {
          type: "object",
          properties: {
            type: { type: "string", enum: ["text", "image_url", "video_url", "audio_url", "draft_task"] },
            role: { type: "string", enum: ["first_frame", "last_frame", "reference_image", "reference_video", "reference_audio"] },
            text: { type: "string" },
          },
        },
      },
    },
  };
  assert.equal(isContentListSchema(doc), true);
  const body = contentListBody(doc, { ...values, prompt: "@video1 is depth. Map onto @image1.", negative: "cuts", quality: "480p", duration: 5.4 });
  assert.deepEqual(body.content, [
    { type: "text", text: "the reference video is depth. Map onto reference image 1.\n\nAvoid: cuts." },
    { type: "video_url", video_url: { url: "https://x/depth.mp4" }, role: "reference_video" },
    { type: "image_url", image_url: { url: "https://x/sheet.png" }, role: "reference_image" },
    { type: "image_url", image_url: { url: "https://x/b.png" }, role: "reference_image" },
  ]);
  assert.equal(body.resolution, "480p");
  assert.equal(body.ratio, "9:16");
  assert.equal(body.duration, 5);
  assert.equal(body.generate_audio, false);
  assert.equal(isContentListSchema({ paths: { "/m": { post: { requestBody: { content: { "application/json": { schema: { type: "object", properties: { prompt: { type: "string" } } } } } } } } } }), false);
});

test("content list with a second reference video numbers them", () => {
  const item = { type: "object", properties: { type: { type: "string", enum: ["text", "image_url", "video_url"] }, role: { type: "string", enum: ["reference_image", "reference_video"] } } };
  const schema = { type: "object", properties: { content: { type: "array", items: item } } };
  const doc = { paths: { "/m": { post: { requestBody: { content: { "application/json": { schema } } } } } } };
  const body = contentListBody(doc as never, { prompt: "Motion from @video1, background from @video2, face from @image1.", videoUrl: "https://x/d.mp4", extraVideoUrls: ["https://x/o.mp4"], imageUrls: ["https://x/s.png"] });
  const content = body.content as { type: string; text?: string; video_url?: { url: string } }[];
  assert.equal(content[0].text, "Motion from reference video 1, background from reference video 2, face from the reference image.");
  assert.deepEqual(content.filter((c) => c.type === "video_url").map((c) => c.video_url!.url), ["https://x/d.mp4", "https://x/o.mp4"]);
});

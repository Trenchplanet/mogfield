# Using MOGFIELD

## 1. Connect

**With a Comfy API key (easiest).** Get a key at
[platform.comfy.org](https://platform.comfy.org), put it in `app/.env` as
`COMFY_API_KEY=…`, and start the server. The header switch shows **API** and
your remaining credits. Every price on a Generate button is an estimate; Comfy
bills the real amount.

**With your own ComfyUI.** Click **LOCAL** in the header and enter your
ComfyUI URL (for example `http://127.0.0.1:8189`, or a cloud GPU pod URL). The
sheet lists, per feature, which custom nodes and model files your ComfyUI is
missing. See the table in the [README](../README.md#local-your-own-comfyui).

**With neither.** The app runs its ffmpeg preview engine: you can click
through everything and try the camera, lens and grade tools without a GPU.

## 2. Make a video from nothing: Video › Create

1. Press **Change** to pick a model. The first group is tuned for MOGFIELD;
   with API on, the second group is every video model in the Comfy API catalog
   (type in the search box to filter).
2. Optionally add a **start frame**, an **end frame**, or up to four
   **reference pictures**.
3. Write the prompt, choose length, shape and resolution, and press
   **Generate**. The take appears in **History** when it is done.

From History you can **Save**, **Extend** a take (continue from its last
frame) or download the **Workflow** it ran.

## 3. Change a real take

- **Video › Restyle**: add a clip, optionally your characters, pick or type a
  style (or add a style picture), describe the world, press Restyle.
- **Video › Re-shoot**: add a clip, pick a new camera angle.
- **Character Swap**: add a clip and the people to put in it. **Easy** does
  everything for you; **Pro** adds preparation (person masks you review),
  drafts and every camera, lens and grade control.

Clips can be uploads or pasted TikTok, Instagram or X links.

## 4. Make pictures and characters: Image

- **Create Image**: a prompt plus up to four references. Results land in your
  library and can be used anywhere a picture is asked for.
- **Create Character**: start from a photo (or a picture you created), add
  elements, approve the picture, then make a character reference sheet.
  **Use in a video** takes it straight to Character Swap.

## 5. Bring it into ComfyUI

**Open in ComfyUI** on the Video and Create Character forms downloads the
exact API-format workflow your current settings would run. Load it in
ComfyUI, swap in your own checkpoints, LoRAs or nodes, and run it there. Every
finished take also keeps its workflow next to the video.

## Tips

- Shorter, steady takes with one clear person swap best.
- Start at 480p or a draft to check a result before paying for 1080p.
- Comfy refuses some requests under its content policy. MOGFIELD shows the
  refusal and never retries or rewrites the request.

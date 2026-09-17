# Architecture

The whole server is roughly 2 000 lines of TypeScript plus one Python bridge. Four decisions carry
most of it.

## 1. A local JSON store, not a database

Media, compositions and render jobs are JSON files under the work directory:

```
/work
├── in/            footage you drop in yourself
├── media/         <uuid>.json  — one record per imported or produced media
├── outputs/       <uuid>.mp4 / .srt / .wav / .gif — every file a tool produces
├── compositions/  <uuid>.json  — the timeline
├── renders/       <uuid>.json  — the render job, with a snapshot of the composition
├── tmp/           scratch, cleaned up after each call
└── models/        SAM2 checkpoint cache (sam2 profile only)
```

Writes go through a temp file and a rename, so a killed process never leaves a half-written record.
A render job carries its own snapshot of the composition, so editing the timeline afterwards cannot
change what a finished render was made from.

**Everything a tool returns is addressable by the next tool.** `media_import` returns an id;
so does every tool that produces a file. The resolver accepts either an id or a path relative to
the work directory, and confines both to it — `realpath` is compared against the work root, so a
symlink or a `..` cannot escape.

## 2. ffmpeg through argv, never a shell

Every ffmpeg and ffprobe call is `spawn(binary, [array of arguments])`. No string interpolation
into a shell, so a filename with a quote or a semicolon in it is just a filename. Calls carry a
hard timeout, a cap on captured output, and an `AbortSignal` so `render_cancel` can actually kill
a running encode.

The default encode is `libx264 -preset medium -crf 20` — portable, and deliberately not the
hardware encoder the original used, which does not exist inside a Linux container.

`-protocol_whitelist file,pipe` is injected before each input, so an imported playlist cannot make
ffmpeg reach out to the network on its own.

## 3. Generation behind a replaceable interface

`src/backends/generation.ts` defines one interface — start a job, poll it, fetch the result — and
two implementations:

- `local`, which takes footage already in the work directory. It is the default, and it needs
  nothing;
- `azure-sora`, which posts to `/openai/v1/videos?api-version=preview`, polls until `completed`,
  and downloads the MP4. Its quirks are the real ones: `seconds` must be a **string** (`"4"`,
  `"8"`, `"12"`), and the accepted sizes are `1280x720`, `720x1280`, `1024x1792` and `1792x1024`
  — `1024x1024` is rejected.

Both models behind that second backend are being retired (24 September 2026 for the OpenAI API,
15 October 2026 for the Azure version). The interface exists so that this is a swap, not a rewrite.

## 4. SAM2 through a Python bridge

The seven `sam2_*` tools are thin TypeScript wrappers that `spawn` `python/sam2_runner.py` with a
subcommand, pass arguments as JSON on stdin, and read JSON back from stdout. Nothing is shelled out.

The runner does the real work: `build_sam2_video_predictor_hf` loads the model, the prompt from
frame 1 is propagated across the shot, masks are refined by erosion plus a Gaussian blur, and the
screen quadrilateral feeds a homography that warps the replacement image onto each frame.

The wrapper checks that the runner and its Python are present **before** calling them, so the
absence of torch produces a sentence telling you to use the `sam2` Docker profile, rather than an
ImportError.

## What was deliberately left out

This server was extracted from a larger private platform. These parts stayed behind:

- the composition store backed by a PostgreSQL table through an HTTP API — replaced by the local
  JSON store above, which is the main reason this repository can run anywhere;
- a cost journal writing to PostgreSQL;
- four tools wrapping named agent personas belonging to one client's pipeline;
- a Remotion bridge and a web preview, which would have pulled a browser into the image;
- hardware-specific encoder settings and absolute paths from the machine it grew up on.

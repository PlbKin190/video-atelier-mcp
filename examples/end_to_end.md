# End to end: two rushes in, a captioned master and a vertical cut out

This is a real transcript. Every call below was run against the Docker image, and the outputs are
the ones it produced. Reproduce it with:

```bash
sh examples/make_sample_footage.sh          # writes work/in/rush1.mp4 and rush2.mp4
docker compose build
```

then ask your agent for the twelve steps. No API key is involved at any point.

## 1–2. Import

Copies the file into the store and registers it. The id is what every later tool takes.

```
media_import  source=/work/in/rush1.mp4   ->  {"id": "b512baad-…", "path": "/work/media/b512baad-….mp4", "name": "rush1.mp4"}
media_import  source=/work/in/rush2.mp4   ->  {"id": "d5d40cec-…", "path": "/work/media/d5d40cec-….mp4", "name": "rush2.mp4"}
```

## 3–4. Cut

Frame-accurate, with re-encoding. Two seconds out of each four-second rush.

```
clip_trim  input=b512baad-…  start=0.5  duration=2.0   ->  {"id": "205b9ae2-…", "path": "/work/outputs/205b9ae2-….mp4"}   # 640x360, 2.00 s
clip_trim  input=d5d40cec-…  start=1.0  duration=2.0   ->  {"id": "bb219af8-…", "path": "/work/outputs/bb219af8-….mp4"}   # 640x360, 2.00 s
```

Note that the trim returned an **id**, not just a path — so it can be fed straight into the next
tool, or added to a composition.

## 5. Order the shots

`clip_concat` normalises everything to one size and frame rate (1920x1080 at 30 fps by default;
pass `width`, `height` and `fps` to choose otherwise).

```
clip_concat  inputs=["205b9ae2-…", "bb219af8-…"]   ->  {"id": "cc186332-…"}   # 1920x1080, 4.00 s
```

## 6–7. Captions

`captions_write_srt` needs nothing but the text and the timings. `captions_burn` puts them in the
picture, using the libass build of ffmpeg that ships in the image.

```
captions_write_srt  segments=[{"start": 0.0, "end": 2.0, "text": "Cut, tracked and rendered"},
                              {"start": 2.0, "end": 4.0, "text": "by an agent, over MCP"}]
                    ->  {"path": "/work/outputs/35277aa3-….srt", "count": 2}

captions_burn  input=cc186332-…  subtitles=35277aa3-…   ->  {"id": "615f39e1-…"}   # 1920x1080, 4.00 s
```

If you run the server **outside** the container against a Homebrew ffmpeg, this step is the one
that fails: that build has no libass, so there is no `subtitles` filter. `health_check` tells you
so before you try, and reports `ok: false`.

## 8–9. Compose and render

A composition is a JSON file. The render job takes a snapshot of it, so editing the timeline later
does not change what this render was made from.

```
comp_create    name="demo" width=640 height=360 fps=25   ->  {"id": "4a23b847-…"}
comp_add_clip  comp_id=4a23b847-…  media_id=615f39e1-…  duration=4.0
render_start   comp_id=4a23b847-…                        ->  {"job_id": "b127be0f-…", "state": "queued"}
```

## 10–11. Follow it and collect it

`render_status` reads the persisted job — no estimated percentage, just the state it actually
recorded. `render_get_output` hands back the finished file.

```
render_status      job_id=b127be0f-…   ->  the persisted job record
render_get_output  job_id=b127be0f-…   ->  {"path": "/work/outputs/b127be0f-….mp4"}   # 640x360, 4.00 s
```

## 12. Export vertical

A centred cover crop, not a squeeze.

```
export_formats  input=b127be0f-…  format="9:16"
                ->  {"id": "5413c785-…", "format": "9:16", "width": 1080, "height": 1920}   # 4.01 s
```

## What you end up with in `work/outputs/`

| File | Size | What it is |
|---|---|---|
| `205b9ae2-….mp4` | 640x360, 2.00 s | first shot, trimmed |
| `bb219af8-….mp4` | 640x360, 2.00 s | second shot, trimmed |
| `cc186332-….mp4` | 1920x1080, 4.00 s | the two, in order |
| `35277aa3-….srt` | 2 cues | the captions |
| `615f39e1-….mp4` | 1920x1080, 4.00 s | captions burned in |
| `b127be0f-….mp4` | 640x360, 4.00 s | the render |
| `5413c785-….mp4` | 1080x1920, 4.01 s | the vertical export |

## Adding screen replacement

With the `sam2` profile running, one more call puts your content on a screen in the shot. Give it
a point on the screen in the first frame; SAM2 does the rest of the frames.

```
sam2_screen_replace  input=<a shot of someone holding a phone>
                     points=[[x, y]]
                     replacement=<the image to show on the screen>
                     output=/work/outputs/replaced.mp4
```

See the stage-by-stage breakdown in the [README](../README.md#screen-replacement).

// tags: signal tags as git lists them, and an annotated tag object read whole.

const SIGNAL_REF = /^refs\/tags\/([a-z0-9]+(?:[_-][a-z0-9]+)*)\.([a-z][a-z0-9.-]*\.[0-9a-f]{12})$/
export type TagRef = {ref: string, actor: string, name: string, object: string, type: string}
export type TagObject = {target: string, tagger: string, time: number, text: string}

// `for-each-ref` lines `<ref> <object> <type>` of tags named `<actor>.<signal>.<message12>`, but for heartbeats.
export const signalTags = (listing: string, heartbeat: (ref: string) => boolean): TagRef[] => listing.split('\n').flatMap(line => {
  const [ref, object, type] = line.split(' ')
  const m = SIGNAL_REF.exec(ref ?? '')
  return m && !heartbeat(ref) ? [{ref, actor: m[1], name: m[2], object, type}] : []
})
// A tag object's target commit, tagger and time, and its text without a signature.
export const tagObject = (body: Buffer): TagObject => {
  const split = body.indexOf('\n\n')
  const hdr = body.subarray(0, split < 0 ? body.length : split).toString('utf8')
  const tagger = /^tagger (.*?) <[^>\n]*> (\d+) [+-]\d{4}$/m.exec(hdr)
  return {
    target: /^object ([0-9a-f]+)\ntype commit$/m.exec(hdr)?.[1] ?? '',
    tagger: tagger?.[1] ?? '',
    time: Number(tagger?.[2] ?? NaN),
    text: split < 0 ? '' : body.subarray(split + 2).toString('utf8').split('-----BEGIN SSH SIGNATURE-----')[0],
  }
}

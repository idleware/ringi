// signer: custody of a local key, independent of its storage, transport and object format. The resolver selects a
// key for a hub/principal; the signer sees exact bytes and an explicit interaction policy, never Git arguments.

declare const key: unique symbol
export type KeyRef = string & {readonly [key]: true}
export type PublicIdentity = {key: string, fingerprint: string}
export type SignRequest = {key: KeyRef, payload: Uint8Array, namespace: string, interaction: 'allowed' | 'forbidden', deadline: number}
export type Signature = {format: string, bytes: Uint8Array, fingerprint: string, namespace: string}
export type SigningReason = 'unavailable' | 'denied' | 'interaction-required' | 'timeout'
export type SigningFault = Error & {reason: SigningReason}
export interface Signer {
  publicIdentity(key: KeyRef): PublicIdentity
  sign(request: SignRequest): Signature
}
// Resolved locally by composition, not from fetched room data. Creation is an explicit bootstrap/join operation.
export type SigningContext = {
  signer: Signer
  resolve(hub: string, principal: string, create?: boolean): KeyRef
  custody?(hub: string, principal: string): string | null
  // The key a room's endpoint names (`keyRef`), the same one for signing and for SSH; where it lives.
  resolveRef?(keyRef: string, create?: boolean): KeyRef
  custodyRef?(keyRef: string): string
}

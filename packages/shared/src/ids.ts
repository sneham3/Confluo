import { customAlphabet } from 'nanoid';

const alphabet = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
const gen12 = customAlphabet(alphabet, 12);
const gen21 = customAlphabet(alphabet, 21);

/** 12-char block id (common doc §6.2) */
export function newBlockId(): string {
  return gen12();
}

export function newClientId(): string {
  return gen21();
}

export function newUploadId(): string {
  return gen12();
}

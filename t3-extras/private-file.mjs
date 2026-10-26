/**
 * Open a log or history file without following a symlink, then force mode 0600
 * on that descriptor (fchmod), including when the file already existed.
 */
import fs from "node:fs";

export const READ_ONLY = fs.constants.O_RDONLY;
export const WRITE_APPEND = fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT;
export const WRITE_NEW = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL;

export function openPrivate(file, flags) {
  const fd = fs.openSync(file, flags | fs.constants.O_NOFOLLOW, 0o600);
  try {
    fs.fchmodSync(fd, 0o600);
    return fd;
  } catch (error) {
    fs.closeSync(fd);
    throw error;
  }
}

/**
 * 编辑器保存之后的 mtime 基线。
 *
 * `finishUpload` 的 stat 是 best-effort（见 `src/backend/sftp-handler.ts`）：stat 失败时
 * `sftp_upload_complete` 不带 `mtime`。这时如果沿用打开编辑器时的旧 mtime，下一次保存
 * 就会拿过期期望值去比对新 mtime，把自己刚写的内容误判成「远端已被修改」。
 * 基线记为未知（-1）表示「不校验」，等下一次保存带回真实 mtime 再恢复冲突检测。
 */

/** 远端 stat 失败、保存后拿不到新 mtime 时使用的基线哨兵值。 */
export const UNKNOWN_MTIME = -1;

/** 保存成功后回填基线：带回 mtime 就用它，否则标为未知。 */
export function nextMtimeBaseline(reported: number | null): number {
  return reported === null ? UNKNOWN_MTIME : reported;
}

/** 下次保存要带的 expectedMtime；基线未知时返回 null（后端不做冲突校验）。 */
export function expectedMtimeFor(baseline: number): number | null {
  return baseline === UNKNOWN_MTIME ? null : baseline;
}

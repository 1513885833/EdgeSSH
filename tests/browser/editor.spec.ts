import { test, expect } from '@playwright/test';
import { connectFiles, fileFixture } from './file-fixture';

const READ_MTIME = 1_790_100_000;

test('在线编辑器：打开、markdown 预览消毒、编辑并 Ctrl+S 保存', async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const fixture = await fileFixture(page);
  await connectFiles(page);
  const list = page.locator('.files-list');

  await list.getByRole('treeitem', { name: 'README.md', exact: true }).dblclick();
  const editor = page.locator('.file-editor');
  await expect(editor).toBeVisible();
  await expect(editor.locator('.cm-content')).toContainText('# Edge SSH');
  await expect(page.locator('#file-edit')).toBeDisabled();

  // 预览：远端 md 里的 <script> 与 javascript: 链接必须被 DOMPurify 去掉。
  await editor.locator('[data-action="preview"]').click();
  const preview = editor.locator('.file-editor-preview');
  await expect(preview).toBeVisible();
  await expect(preview.locator('h1')).toHaveText('Edge SSH');
  expect(await preview.locator('script').count()).toBe(0);
  expect(await preview.innerHTML()).not.toContain('javascript:');
  expect(await page.evaluate(() => (window as unknown as { __xss?: number }).__xss)).toBeUndefined();
  await page.screenshot({ path: testInfo.outputPath('editor-preview.png') });

  await editor.locator('[data-action="preview"]').click();
  const content = editor.locator('.cm-content');
  await content.click();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.type('# Saved by editor\n');
  await expect(editor.locator('.file-editor-state')).toHaveText('未保存');
  await page.keyboard.press('ControlOrMeta+s');
  await expect(editor.locator('.file-editor-state')).toHaveText('已保存');

  const starts = fixture.calls.filter((call) => call.type === 'sftp_upload_start');
  expect(starts).toHaveLength(1);
  expect(starts[0]).toMatchObject({ path: '/root/README.md', overwrite: true, expectedMtime: READ_MTIME });
  expect(fixture.textFiles.get('/root/README.md')!.content).toBe('# Saved by editor\n');
  expect(fixture.textFiles.get('/root/README.md')!.mtime).toBe(READ_MTIME + 1);
  await page.screenshot({ path: testInfo.outputPath('editor-saved.png') });
  expect(errors).toEqual([]);
});

test('mtime 冲突：先阻止覆盖，取消保留草稿，确认后才强制保存', async ({ page }) => {
  const fixture = await fileFixture(page);
  await connectFiles(page);
  await page.locator('.files-list').getByRole('treeitem', { name: 'README.md', exact: true }).click();
  await page.locator('#file-edit').click();
  const editor = page.locator('.file-editor');
  await expect(editor).toBeVisible();

  // 模拟「打开之后别人改了远端文件」。
  fixture.textFiles.get('/root/README.md')!.mtime = READ_MTIME + 60;

  const content = editor.locator('.cm-content');
  await content.click();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.type('# Conflict draft\n');

  const cancelDialog = page.waitForEvent('dialog').then((dialog) => dialog.dismiss());
  await page.keyboard.press('ControlOrMeta+s');
  await cancelDialog;
  await expect(editor.locator('.file-editor-state')).toContainText('保存已取消');
  expect(fixture.textFiles.get('/root/README.md')!.content).toContain('<script>');

  // 有未保存改动时关闭编辑器必须先确认；取消则留在编辑器里。
  const keepEditing = page.waitForEvent('dialog').then((dialog) => dialog.dismiss());
  await editor.locator('[data-action="close"]').click();
  await keepEditing;
  await expect(editor).toBeVisible();
  await expect(editor).toHaveClass(/is-dirty/);
  await expect(editor.locator('[data-action="save"]')).toBeEnabled();

  // 再次保存并确认覆盖：这次不带 expectedMtime，写入成功。
  const overwriteDialog = page.waitForEvent('dialog').then((dialog) => dialog.accept());
  await page.keyboard.press('ControlOrMeta+s');
  await overwriteDialog;
  await expect(editor.locator('.file-editor-state')).toHaveText('已保存');
  const starts = fixture.calls.filter((call) => call.type === 'sftp_upload_start');
  // 两次带 expectedMtime 的尝试都被拒绝（第一次取消、第二次确认后强制覆盖），最后一条才真正写入。
  expect(starts.map((call) => call.expectedMtime)).toEqual([READ_MTIME, READ_MTIME, undefined]);
  expect(fixture.textFiles.get('/root/README.md')!.content).toBe('# Conflict draft\n');
});

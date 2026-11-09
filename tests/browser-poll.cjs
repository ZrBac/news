// waitForFunction treats a Promise as truthy before it resolves. Poll asynchronous
// browser checks here so worker activation and cache cleanup really finish.
module.exports = async function waitForBrowser(page, predicate, arg) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (await page.evaluate(predicate, arg)) return;
    await page.waitForTimeout(500);
  }
  throw new Error("Timed out waiting for asynchronous browser state");
};

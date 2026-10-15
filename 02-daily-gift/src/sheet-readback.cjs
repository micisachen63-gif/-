async function waitForStableReadback({
  read,
  wait,
  matches,
  verify = value => value,
  formatObserved = value => value,
  label,
  expectedDescription,
  attempts = 15,
  intervalMs = 400,
}) {
  let previous;
  let lastVerificationError = '';
  const observed = [];

  for (let attempt = 0; attempt < attempts; attempt++) {
    const value = String((await read()) ?? '').trim();
    observed.push(formatObserved(value));
    if (value === previous && matches(value)) {
      try {
        return verify(value);
      } catch (error) {
        lastVerificationError = error.message;
      }
    }
    previous = value;
    if (attempt + 1 < attempts) await wait(intervalMs);
  }

  const verification = lastVerificationError ? `；讀回驗證未通過：${lastVerificationError}` : '';
  throw new Error(`${label}讀回未穩定（${expectedDescription}；重讀筆數：${observed.join('→')}）${verification}`);
}

module.exports = { waitForStableReadback };

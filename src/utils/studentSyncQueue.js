// Single-instance coordination: central refresh and Notion onboarding cannot race identity matching.
let tail = Promise.resolve();
module.exports = function serialize(run) {
  const result = tail.then(run, run);
  tail = result.catch(() => {});
  return result;
};

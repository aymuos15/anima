(function () {
  window.preopProgress = function (patient, step) {
    var done = patient.checklist.filter(function (item) { return item.state === 'done'; }).length;
    var messages = patient.transcript.filter(function (message) { return message.from === 'agent'; });
    var latest = messages.length ? messages[messages.length - 1].text : '';
    var booked = patient.checklist.filter(function (item) { return item.state === 'booked'; });
    var stage = !patient.sessionId ? 'Not started' : patient.status === 'clinical_review' ? 'Clinical review' : latest.includes('?') ? 'Your next reply' : done === 5 ? 'Preparation complete' : booked.length ? 'Waiting for tests' : 'Preparation in progress';
    var next = !patient.sessionId ? 'Start the preparation conversation. The team will guide you through each question.' : latest || 'Open the conversation to continue your preparation.';
    return { done: done, stage: stage, next: next, week: step, canReply: !!patient.sessionId && patient.status !== 'clinical_review', booked: booked.length };
  };
})();

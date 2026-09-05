function todayInJapan(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function nextNthWeekday(startDate, weekday, occurrences) {
  const allowedOccurrences = new Set(occurrences);
  const cursor = new Date(`${startDate}T00:00:00Z`);
  for (let offset = 0; offset < 70; offset += 1) {
    const candidate = new Date(cursor);
    candidate.setUTCDate(cursor.getUTCDate() + offset);
    const occurrence = Math.floor((candidate.getUTCDate() - 1) / 7) + 1;
    if (candidate.getUTCDay() === weekday && allowedOccurrences.has(occurrence)) {
      return candidate.toISOString().slice(0, 10);
    }
  }
  throw new Error('次回開催日を計算できませんでした');
}

function getUpcomingPortalDates(now = new Date()) {
  const today = todayInJapan(now);
  return {
    bucchakeVtuber: nextNthWeekday(today, 5, [1, 3]),
    classLesson: nextNthWeekday(today, 3, [2, 4]),
  };
}

module.exports = { todayInJapan, nextNthWeekday, getUpcomingPortalDates };

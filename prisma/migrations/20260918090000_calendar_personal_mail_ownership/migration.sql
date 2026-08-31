-- Revisit the configured CYON mail window once after personal calendar
-- ownership was introduced. MailMessage rows are deduplicated by Message-ID;
-- only their text/calendar parts are reprocessed and linked to the actual
-- Employee recipients (To/CC/ATTENDEE).
UPDATE MailSetting
SET imapLastUid = 0,
    imapSentLastUid = 0,
    imapLastSummary = 'Kalendereinladungen werden Personen neu zugeordnet.'
WHERE imapCaptureEnabled = 1
  AND imapHost IS NOT NULL
  AND TRIM(imapHost) <> '';

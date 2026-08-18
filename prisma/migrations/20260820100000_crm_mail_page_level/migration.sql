-- E-MAIL-SEITE IM SEITENKATALOG (17.08.2026).
--
-- Die neue Seite `crm.mail` (/crm/mail, Outlook-Postfach) fehlt in den
-- gespeicherten Stufenkarten aller bestehenden Rollen — und "fehlt" heisst dort
-- "kein Zugriff". Wer den Interaktionsverlauf (`crm.communication`) sehen darf,
-- soll das Postfach auf derselben Stufe sehen: es ist dieselbe Kundenkommunikation,
-- nur mit den E-Mails aus Outlook. Rollen ohne Stufenkarte (Altbestand) und
-- Administratorrollen sind nicht betroffen (sie rechnen aus Rechten bzw. dem
-- ganzen Katalog).
--
-- Apply with: npx prisma migrate deploy

UPDATE `Role`
   SET `pageLevels` = JSON_SET(`pageLevels`, '$."crm.mail"', JSON_EXTRACT(`pageLevels`, '$."crm.communication"'))
 WHERE `pageLevels` IS NOT NULL
   AND JSON_VALID(`pageLevels`)
   AND JSON_EXTRACT(`pageLevels`, '$."crm.communication"') IS NOT NULL
   AND JSON_EXTRACT(`pageLevels`, '$."crm.mail"') IS NULL;

/**
 * The day report, delivered.
 *
 * Render runs this on a schedule at your cut-off time. With no mail settings it
 * prints the report instead of sending it, so the schedule can be proved before
 * any account is connected.
 */
import 'dotenv/config';
import nodemailer from 'nodemailer';
import { pool } from './db.js';
import { loadBook } from './book.js';
import { dayHeadline, dayReport } from './report.js';

const date = process.argv[2] ?? new Date().toISOString().slice(0, 10);
const book = await loadBook();
const text = dayReport(book, date);
const headline = dayHeadline(book, date);

const to = process.env.REPORT_TO;
const smtp = process.env.SMTP_URL;

if (!to || !smtp) {
  console.log('No REPORT_TO / SMTP_URL set — printing the report instead of sending it.\n');
  console.log(text);
} else {
  const transport = nodemailer.createTransport(smtp);
  await transport.sendMail({
    from: process.env.REPORT_FROM ?? to,
    to,
    subject: `Book — ${date} · ${headline}`,
    text,
  });
  console.log(`Sent the ${date} report to ${to}.`);
}

await pool.end();

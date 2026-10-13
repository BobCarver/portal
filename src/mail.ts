/**
 * Outgoing email (magic links, password resets). The console mailer prints the
 * message, which is enough for development and a single organiser; swap in an
 * SMTP or API mailer for public registration.
 */
export interface Mail {
  to: string;
  subject: string;
  text: string;
}

export interface Mailer {
  send(mail: Mail): Promise<void>;
}

export class ConsoleMailer implements Mailer {
  send(mail: Mail): Promise<void> {
    console.log(
      `--- mail to ${mail.to}: ${mail.subject}\n${mail.text}\n---`,
    );
    return Promise.resolve();
  }
}

/** Keeps what was sent (tests). */
export class MemoryMailer implements Mailer {
  sent: Mail[] = [];
  send(mail: Mail): Promise<void> {
    this.sent.push(mail);
    return Promise.resolve();
  }
}

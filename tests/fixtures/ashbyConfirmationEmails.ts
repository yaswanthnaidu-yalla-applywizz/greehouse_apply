import type {
  AshbyConfirmationMessage,
  AshbyConfirmationContext,
} from '../../src/services/inbox/ashbyConfirmationMatcher.js';

export interface AshbyEmailFixture {
  name: string;
  message: AshbyConfirmationMessage;
  context: AshbyConfirmationContext;
}

export const ashbyPositiveFixtures: AshbyEmailFixture[] = [
  {
    name: 'Orchard Robotics',
    message: {
      from: 'no-reply@ashbyhq.com',
      to: 'candidate@applywizard.ai',
      subject: 'Thanks for applying to Orchard Robotics!',
      bodyText:
        'Hi Candidate ,\n\nThank you for applying for the Senior Machine Learning Engineer role at Orchard Robotics ! We appreciate your interest in joining the team. We will review your application and get back to you if there are next steps.\n\nAll the best,\n\nOrchard Robotics Hiring Team\nThis email was sent via Ashby. Report this email',
    },
    context: {
      candidateEmail: 'candidate@applywizard.ai',
      companyName: 'Orchard Robotics',
      jobTitle: 'Senior Machine Learning Engineer',
    },
  },
  {
    name: 'Nexxen',
    message: {
      from: 'no-reply@ashbyhq.com',
      to: 'candidate@applywizard.ai',
      subject: 'Thank You for Applying to Nexxen!',
      bodyText:
        'Hi Candidate ,\n Thank you for your interest in Nexxen! We wanted to let you know we received your application for the Senior Machine Learning Engineer role and we are pleased that you are interested in joining our team.\n\n Our team will review your application and will be in touch if your qualifications match our needs for the role.\n\nBest,\n\n Nexxen Talent Acquisition Team',
    },
    context: {
      candidateEmail: 'candidate@applywizard.ai',
      companyName: 'Nexxen',
      jobTitle: 'Senior Machine Learning Engineer',
    },
  },
  {
    name: 'Phantom',
    message: {
      from: 'no-reply@ashbyhq.com',
      to: 'candidate@applywizard.ai',
      subject: 'Thank you for applying to Phantom',
      bodyText:
        'Candidate ,\n\n Thanks for applying to Phantom. Your application has been received and will be reviewed by our team. Please keep an eye out for a response in the coming days.\n\n Regards,\nPhantom',
    },
    context: {
      candidateEmail: 'candidate@applywizard.ai',
      companyName: 'Phantom',
      jobTitle: 'Software Engineer',
    },
  },
  {
    name: 'Keycard',
    message: {
      from: 'no-reply@keycard.ai',
      to: 'candidate@applywizard.ai',
      subject: 'Thanks for applying to Keycard!',
      bodyText:
        'Hi Candidate ,\n\nThank you for applying for the Software Engineer, Security role at Keycard ! We appreciate your interest in joining the team. We will review your application and get back to you if there are next steps.\n\nAll the best,\n\n Keycard Hiring Team',
    },
    context: {
      candidateEmail: 'candidate@applywizard.ai',
      companyName: 'Keycard',
      jobTitle: 'Software Engineer, Security',
    },
  },
  {
    name: 'The Zebra',
    message: {
      from: 'no-reply@ashbyhq.com',
      to: 'candidate@applywizard.ai',
      subject: 'Thank You For Applying @ The Zebra!',
      bodyText:
        'Hi Candidate ,\n\n Woohoo - you’ve applied to The Zebra’s Senior Data Scientist position! We appreciate you taking the time to do so.\n\n Next steps: Check your email for an update on your application. We will follow up regardless of the decision.\n\nCheers, & talk to you soon!\n\n The Z-Team',
    },
    context: {
      candidateEmail: 'candidate@applywizard.ai',
      companyName: 'The Zebra',
      jobTitle: 'Senior Data Scientist',
    },
  },
  {
    name: '42dot',
    message: {
      from: 'no-reply@ashbyhq.com',
      to: 'candidate@applywizard.ai',
      subject: '[42dot] Thank you for your interest in 42dot',
      bodyText:
        'Hello Candidate Kumar , this is the 42dot recruiting team.\n\n Thank you for your interest in joining 42dot, and thank you for applying for the position Machine Learning Engineer, Driving Foundation Models .\n\n We are pleased to report that your application has been successfully submitted.\n\n Recruiters and related departments will thoroughly review your application.\n We will review and communicate the screening process results as soon as possible.\n\nBest Regards,\n 42dot Recruiting Team',
    },
    context: {
      candidateEmail: 'candidate@applywizard.ai',
      companyName: '42dot',
      jobTitle: 'Machine Learning Engineer, Driving Foundation Models',
    },
  },
  {
    name: 'Inworld',
    message: {
      from: 'no-reply@ashbyhq.com',
      to: 'candidate@applywizard.ai',
      subject: 'Thank you for applying to Inworld',
      bodyText:
        'Hi Candidate ,\n\n Thanks for applying to Inworld . Your application has been received and we will review it right away.\n\n If your application seems like a good fit for the position we will contact you soon.\n\n Regards,\n\n Inworld',
    },
    context: {
      candidateEmail: 'candidate@applywizard.ai',
      companyName: 'Inworld',
      jobTitle: 'Senior Software Engineer',
    },
  },
  {
    name: 'Replit',
    message: {
      from: 'no-reply@ashbyhq.com',
      to: 'candidate@applywizard.ai',
      subject: 'Thank you for your application to Replit',
      bodyText:
        "Hi Candidate ,\n\n Thank you for your interest in Replit ! We received your application for the Software Engineer, Replit Cloud role, and we're excited you are interested in being part of what we're building.\n\n Our talent team will be in touch if your qualifications match our needs for the role. If you are not selected for this position, keep an eye on our careers page as we’re growing quickly and adding openings.\n\n Best,\n The Talent Team @ Replit",
    },
    context: {
      candidateEmail: 'candidate@applywizard.ai',
      companyName: 'Replit',
      jobTitle: 'Software Engineer, Replit Cloud',
    },
  },
];

export const ashbyRejectionFixtures: AshbyEmailFixture[] = [
  {
    name: 'Plenful',
    message: {
      from: 'no-reply@ashbyhq.com',
      to: 'candidate@applywizard.ai',
      subject: 'Update on Your Senior Machine Learning Engineer Application at Plenful',
      bodyText:
        "Hi Candidate ,\n\n Thank you so much for your interest in Senior Machine Learning Engineer at Plenful!\n\n After careful consideration, we've decided to move forward with other candidates whose experience more closely matches our requirements. This wasn't an easy call.\n\n We're growing quickly and opening new roles every week — we'd encourage you to keep an eye on our career page for what's next.\n\n If you applied to other positions with us, you're still under consideration for those.\n\n Wishing you all the best,\nThe Plenful Talent Team",
    },
    context: {
      candidateEmail: 'candidate@applywizard.ai',
      companyName: 'Plenful',
      jobTitle: 'Senior Machine Learning Engineer',
    },
  },
  {
    name: 'LiveRamp',
    message: {
      from: 'no-reply@ashbyhq.com',
      to: 'candidate@applywizard.ai',
      subject: 'Update on Your Application to LiveRamp',
      bodyText:
        'Hi Candidate ,\n\n Thank you for your interest in joining LiveRamp and for taking the time to apply for the Sr. DevOps Engineer position.\n\n After careful consideration of your application, we will not be moving forward with your candidacy at this time. We truly appreciate your effort and interest in our team.\n\n We wish you all the best in your job search and future endeavors.\n\n Thank you again for considering LiveRamp as a potential employer.\n\n Best regards,\nLiveRamp Recruiting Team\n LiveRamp, Inc.',
    },
    context: {
      candidateEmail: 'candidate@applywizard.ai',
      companyName: 'LiveRamp',
      jobTitle: 'Sr. DevOps Engineer',
    },
  },
  {
    name: 'Juicebox',
    message: {
      from: 'no-reply@ashbyhq.com',
      to: 'candidate@applywizard.ai',
      subject: 'Juicebox | Followup to your Application for Engineering Lead',
      bodyText:
        "Hi Candidate ,\n\n Thank you for taking the time to apply for the Engineering Lead position at Juicebox. We appreciate your interest in our team and the effort you put into your application.\n\n After careful review, we've decided not to move forward with your application at this time. This was a difficult decision due to the high volume of strong applicants.\n\n We truly appreciate your interest in Juicebox and encourage you to apply again in the future if a role opens that feels like a strong fit.\n\n Wishing you all the best in your job search, and thank you again for considering Juicebox.\n\n Talent Team\n Juicebox\n 77 Federal St, Fl 2, San Francisco, CA 94107",
    },
    context: {
      candidateEmail: 'candidate@applywizard.ai',
      companyName: 'Juicebox',
      jobTitle: 'Engineering Lead',
    },
  },
  {
    name: 'Plaid',
    message: {
      from: 'no-reply@ashbyhq.com',
      to: 'candidate@applywizard.ai',
      subject: 'Update on Your Application with Plaid',
      bodyText:
        'Hi Candidate ,\n\n Thank you for your interest in joining Plaid and for taking the time to apply to the Data Scientist role. After reviewing your application, it appears that you indicated you’re not able to meet the in-office expectations for this role. As such, we’re unable to move forward with your application at this time.\n\n We appreciate your interest and wish you the best in your job search.\n\n Best,\nPlaid Recruiting Team',
    },
    context: {
      candidateEmail: 'candidate@applywizard.ai',
      companyName: 'Plaid',
      jobTitle: 'Data Scientist',
    },
  },
  {
    name: 'Fluidstack',
    message: {
      from: 'no-reply@ashbyhq.com',
      to: 'candidate@applywizard.ai',
      subject: 'Fluidstack Application Update',
      bodyText:
        'Hi Candidate ,\n\n Thank you for your interest in Fluidstack. After reviewing your application, we’ve decided to move forward with other candidates whose experience more closely aligns the requirements of the Machine Learning Engineer role.\n\n We appreciate the time and effort you put into applying and wish you every success in your job search and future endeavors.\n\n Fluidstack Talent Team',
    },
    context: {
      candidateEmail: 'candidate@applywizard.ai',
      companyName: 'Fluidstack',
      jobTitle: 'Machine Learning Engineer',
    },
  },
];

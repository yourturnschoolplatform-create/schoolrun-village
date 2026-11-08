import { Router, type Request, type Response } from 'express';
import {
  PARTNER_INQUIRY_CATEGORIES,
  validatePartnerInquiry,
  type PartnerInquiryInput,
} from '../shared/hot-deals.js';

type StoredPartnerInquiry = PartnerInquiryInput & {
  id: string;
  receivedAt: string;
};

const inquiries: StoredPartnerInquiry[] = [];

function noStore(response: Response): void {
  response.setHeader('Cache-Control', 'no-store, max-age=0');
}

/**
 * B2B partner inquiry intake. In-memory for pilot; no service-role / RLS tables.
 * Field names avoid banned phone/price column patterns.
 */
export function createPartnerRouter() {
  const router = Router();

  router.post('/inquiries', (request: Request, response: Response) => {
    const body = (request.body ?? {}) as Partial<PartnerInquiryInput>;
    const input: PartnerInquiryInput = {
      businessName: String(body.businessName ?? ''),
      contactEmail: String(body.contactEmail ?? ''),
      contactNumber: String(body.contactNumber ?? ''),
      category: String(body.category ?? ''),
      proposedTerms: String(body.proposedTerms ?? ''),
      message: String(body.message ?? ''),
    };

    const invalid = validatePartnerInquiry(input);
    if (invalid) {
      noStore(response);
      response.status(400).json({ error: 'invalid_partner_inquiry', message: invalid });
      return;
    }

    if (!PARTNER_INQUIRY_CATEGORIES.includes(input.category as (typeof PARTNER_INQUIRY_CATEGORIES)[number])) {
      noStore(response);
      response.status(400).json({ error: 'invalid_partner_inquiry', message: 'Choose a partner category.' });
      return;
    }

    const saved: StoredPartnerInquiry = {
      ...input,
      businessName: input.businessName.trim(),
      contactEmail: input.contactEmail.trim().toLowerCase(),
      contactNumber: input.contactNumber.trim(),
      proposedTerms: input.proposedTerms.trim().slice(0, 500),
      message: input.message.trim().slice(0, 2000),
      id: `partner_${Date.now().toString(36)}`,
      receivedAt: new Date().toISOString(),
    };
    inquiries.push(saved);

    noStore(response);
    response.status(201).json({
      ok: true,
      id: saved.id,
      message: 'Thanks — your partner inquiry is with the SchoolRun Village partnerships team.',
    });
  });

  return router;
}

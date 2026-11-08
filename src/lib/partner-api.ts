import type { PartnerInquiryInput } from '../../shared/hot-deals';

export const partnerApi = {
  async submitInquiry(input: PartnerInquiryInput): Promise<{ ok: true; id: string; message: string }> {
    const response = await fetch('/api/partner/inquiries', {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
    const payload = await response.json().catch(() => ({})) as {
      ok?: boolean;
      id?: string;
      message?: string;
      error?: string;
    };
    if (!response.ok) {
      throw new Error(payload.message || 'Your partner inquiry could not be sent right now.');
    }
    return {
      ok: true,
      id: payload.id || 'received',
      message: payload.message || 'Thanks — your partner inquiry is with the SchoolRun Village partnerships team.',
    };
  },
};

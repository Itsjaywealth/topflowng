(function () {
  'use strict';

  const logos = Object.freeze({
    MTN: { src: '/assets/providers/mtn.svg', alt: 'MTN logo' },
    AIRTEL: { src: '/assets/providers/airtel.png', alt: 'Airtel logo' },
    GLO: { src: '/assets/providers/glo.png', alt: 'Glo logo' },
    '9MOBILE': { src: '/assets/providers/9mobile.webp', alt: '9mobile logo' },
    IKEDC: { src: '/assets/providers/ikedc.png', alt: 'Ikeja Electric logo' },
    EKEDC: { src: '/assets/providers/ekedc.png', alt: 'Eko Electricity Distribution Company logo' },
    AEDC: { src: '/assets/providers/aedc.png', alt: 'Abuja Electricity Distribution Company logo' },
    PHEDC: { src: '/assets/providers/phedc.jpg', alt: 'Port Harcourt Electricity Distribution logo' },
    KEDC: { src: '/assets/providers/kedc.png', alt: 'Kano Electricity Distribution Company logo' },
    IBEDC: { src: '/assets/providers/ibedc.png', alt: 'Ibadan Electricity Distribution Company logo' },
    DSTV: { src: '/assets/providers/dstv.png', alt: 'DStv logo' },
    GOTV: { src: '/assets/providers/gotv.png', alt: 'GOtv logo' },
    STARTIMES: { src: '/assets/providers/startimes.png', alt: 'StarTimes logo' },
    WAEC: { src: '/assets/providers/waec.png', alt: 'WAEC logo' },
    PAYSTACK: { src: '/assets/providers/paystack.svg', alt: 'Paystack logo' },
    VTPASS: { src: '/assets/providers/vtpass.png', alt: 'VTPass logo' },
  });

  const aliases = Object.freeze([
    ['9MOBILE', /\b(9mobile|etisalat)\b/i],
    ['STARTIMES', /\bstartimes\b/i],
    ['PHEDC', /\b(phedc|phed|port harcourt electric(?:ity)?)\b/i],
    ['IKEDC', /\b(ikedc|ikeja electric)\b/i],
    ['EKEDC', /\b(ekedc|eko electric)\b/i],
    ['IBEDC', /\b(ibedc|ibadan electric)\b/i],
    ['AEDC', /\b(aedc|abuja electric)\b/i],
    ['KEDC', /\b(kedc|kano electric)\b/i],
    ['AIRTEL', /\bairtel\b/i],
    ['MTN', /\bmtn\b/i],
    ['GLO', /\bglo\b/i],
    ['DSTV', /\bdstv\b/i],
    ['GOTV', /\bgotv\b/i],
    ['WAEC', /\bwaec\b/i],
    ['PAYSTACK', /\b(paystack|wallet fund(?:ing)?|card payment)\b/i],
    ['VTPASS', /\bvtpass\b/i],
  ]);

  function normalize(value) {
    return String(value || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  }

  function keyFor(value) {
    const normalized = normalize(value);
    if (logos[normalized]) return normalized;
    const match = aliases.find(([, pattern]) => pattern.test(String(value || '')));
    return match ? match[0] : null;
  }

  function image(value, className) {
    const key = keyFor(value);
    if (!key) return '';
    const logo = logos[key];
    const cls = className ? ` ${className}` : '';
    return `<img class="provider-logo${cls}" src="${logo.src}" alt="${logo.alt}" loading="lazy" decoding="async" data-provider-logo="${key}">`;
  }

  window.TopFlowLogos = Object.freeze({ logos, keyFor, image });
}());

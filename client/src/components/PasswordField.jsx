import { useState } from 'react';

// ═══════════════════════════════════════════════════════════════════════════
// A password input with a show/hide toggle.
//
// Auditors type these on a phone, where a mistyped character is invisible and
// impossible to spot — and the login limiter allows only 10 attempts per IP per
// 15 minutes, so guessing at a typo is expensive. Being able to look at what
// you typed is the cheapest fix.
//
// The toggle sits INSIDE the right edge of the field, absolutely positioned, so
// revealing the password never shifts or resizes anything on the form. The
// input keeps `pr-14` in both states for the same reason: the padding that
// keeps text clear of the button must not depend on which state it is in.
// ═══════════════════════════════════════════════════════════════════════════
export default function PasswordField({
  // Spacing/layout belongs on the wrapper, never on the input — a margin on the
  // input would move it relative to the absolutely-positioned button.
  wrapperClassName = '',
  className = 'field',
  ...inputProps
}) {
  const [shown, setShown] = useState(false); // hidden by default

  return (
    <div className={`relative ${wrapperClassName}`}>
      <input
        {...inputProps}
        type={shown ? 'text' : 'password'}
        className={`${className} pr-14`}
      />
      <button
        // type="button" — inside a <form> the default is "submit", which would
        // fire a login attempt every time someone peeked at their password.
        type="button"
        onClick={() => setShown((s) => !s)}
        aria-label={shown ? 'Hide password' : 'Show password'}
        aria-pressed={shown}
        // 48px wide and the full height of the field (~50px), comfortably over
        // the 44px minimum for a thumb.
        className="absolute inset-y-0 right-0 flex w-12 min-h-[44px] items-center
                   justify-center rounded-r-xl text-slate-400 transition
                   hover:text-slate-700 focus:outline-none focus-visible:text-brand"
        tabIndex={-1}
      >
        {shown ? <EyeOff /> : <Eye />}
      </button>
    </div>
  );
}

const Eye = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor"
       strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
    <circle cx="12" cy="12" r="3" />
  </svg>
);

const EyeOff = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor"
       strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94" />
    <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19" />
    <path d="M14.12 14.12a3 3 0 1 1-4.24-4.24" />
    <line x1="1" y1="1" x2="23" y2="23" />
  </svg>
);

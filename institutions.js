const INSTITUTIONS = [
  {
    id: "unilus",
    name: "University of Lusaka (UNILUS)",
    domain: "unilus.ac.zm",
    status: "licensed",
    approvedPages: [
      "https://web.unilus.ac.zm/contact-us/",
      "https://web.unilus.ac.zm/registation-notice/",
      "https://web.unilus.ac.zm/fees/"
    ],
    addedDate: "2026-09-07"
  }
];

function getInstitutionById(id) {
  return INSTITUTIONS.find(inst => inst.id === id) || null;
}

module.exports = { INSTITUTIONS, getInstitutionById };

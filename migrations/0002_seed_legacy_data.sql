-- Portable seed data ported from legacy-data/database.sqlite (no SQLite-version-specific functions).
INSERT INTO room_workflows (room_id, role, specialty, yaml_payload) VALUES ('cardiology-intake-room-v1', 'Architect', 'MultiSpecialty', 'formId: cardiology-intake-room-v1
composition:
  - resourceType: Patient
    fields:
      - path: "Patient.gender"
        label: "Biological Sex Mapping"
        uiComponent: "Dropdown"
        choices: ["male", "female", "other"]
        required: true
  - resourceType: Observation
    fields:
      - path: "Observation.valueQuantity"
        label: "Systolic Blood Pressure Measurement"
        uiComponent: "NumericInput"
        required: true
        unit: "mmHg"
  - resourceType: Condition
    fields:
      - path: "Condition.clinicalStatus"
        label: "Diagnostic Abnormality Flag"
        uiComponent: "TextInput"');
INSERT INTO room_workflows (room_id, role, specialty, yaml_payload) VALUES ('clinic-onboarding-protocol-v1', 'Architect', 'Cardiology', 'formId: clinic-onboarding-protocol-v1
title: "ClinixFlow Enterprise Administrative Bootstrapper"
composition:
  - resourceType: Organization
    id: section_organization
    label: "1. Corporate Registration & Billing Details"
    fields:
      - id: "onboarding_org_name"
        path: "Organization.name"
        label: "Official Clinical Practice Name"
        uiComponent: "TextInput"
        required: true
      - id: "onboarding_org_tax"
        path: "Organization.identifier.value"
        label: "Practice Corporate Tax Identifier Number"
        uiComponent: "TextInput"

  - resourceType: Location
    id: section_location
    label: "2. Physical Facility Operating Address"
    fields:
      - id: "onboarding_loc_name"
        path: "Location.name"
        label: "Facility Branch Name"
        uiComponent: "TextInput"
        required: true
      - id: "onboarding_loc_address"
        path: "Location.address.text"
        label: "Complete Facility Physical Postal Address"
        uiComponent: "TextInput"

  - resourceType: Practitioner
    id: section_practitioner
    label: "3. Lead Clinical Staff and Role Registration"
    fields:
      - id: "onboarding_staff_name"
        path: "Practitioner.name.text"
        label: "Full Name of Lead Medical Provider"
        uiComponent: "TextInput"
        required: true
  - resourceType: PractitionerRole
    id: section_practitioner_role
    label: "4. Provider Clinical Specialty Assignment"
    fields:
      - id: "onboarding_staff_specialty"
        path: "PractitionerRole.code.coding.code" # MATCHES RESOURCE TYPE PERFECTLY
        label: "Lead Core Clinical Specialty"
        uiComponent: "MultiSelect"
        choices: ["Cardiology", "Pediatrics", "Emergency Medicine", "Endocrinology"]
');
INSERT INTO room_workflows (room_id, role, specialty, yaml_payload) VALUES ('emergency-triage-matrix-v1', 'Architect', 'Cardiology', 'formId: emergency-triage-matrix-v1
title: "Advanced Emergency Department Resuscitation Layout"
composition:
  - resourceType: Encounter
    id: section_encounter
    label: "1. Triage Classification"
    fields:
      - id: "triage_acuity"
        path: "Encounter.status"
        label: "Acuity Level Assignment"
        uiComponent: "Dropdown"
        choices: ["triaged", "in-progress", "finished"]
        required: true
  - resourceType: Observation
    id: section_trauma_vitals
    label: "2. Resuscitation Hemodynamics"
    itemControl: "gtable"
    repeats: true
    fields:
      - id: "heart_rate"
        path: "Observation.component.valueQuantity.value"
        label: "Heart Rate Metrics"
        uiComponent: "NumericInput"
        unit: "bpm"
        required: true
      - id: "oxygen_saturation"
        path: "Observation.component.valueQuantity.value"
        label: "Peripheral Oxygen Saturation"
        uiComponent: "NumericInput"
        unit: "%"
        required: true
  - resourceType: Condition
    id: section_acute_findings
    label: "3. Traumatic Diagnostic Findings"
    fields:
      - id: "primary_diagnosis"
        path: "Condition.clinicalStatus.coding.code"
        label: "Suspected Acute Traumatic Injury"
        uiComponent: "Autocomplete"
        valueSetUrl: "https://nih.gov"
      - id: "injury_severity"
        path: "Condition.severity.coding.code"
        label: "Trauma Severity Scale Evaluation"
        uiComponent: "Dropdown"
        choices: ["Mild", "Moderate", "Severe"]
        skipLogic:
          sourceField: "primary_diagnosis"
          operator: "exists"
      - id: "primary_diagnosis"
        path: "Condition.clinicalStatus.coding.code"
        label: "Suspected Acute Traumatic Injury"
        uiComponent: "Autocomplete"
        valueSetUrl: "https://nih.gov"
      - id: "injury_severity"
        path: "Condition.severity.coding.code"
        label: "Trauma Severity Scale Evaluation"
        uiComponent: "Dropdown"
        choices: ["Mild", "Moderate", "Severe"]
        skipLogic:
          sourceField: "primary_diagnosis"
          operator: "exists"
      - id: "primary_diagnosis"
        path: "Condition.clinicalStatus.coding.code"
        label: "Suspected Acute Traumatic Injury"
        uiComponent: "Autocomplete"
        valueSetUrl: "https://nih.gov"
      - id: "injury_severity"
        path: "Condition.severity.coding.code"
        label: "Trauma Severity Scale Evaluation"
        uiComponent: "Dropdown"
        choices: ["Mild", "Moderate", "Severe"]
        skipLogic:
          sourceField: "primary_diagnosis"
          operator: "exists"
      - id: "primary_diagnosis"
        path: "Condition.clinicalStatus.coding.code"
        label: "Suspected Acute Traumatic Injury"
        uiComponent: "Autocomplete"
        valueSetUrl: "https://nih.gov"
      - id: "injury_severity"
        path: "Condition.severity.coding.code"
        label: "Trauma Severity Scale Evaluation"
        uiComponent: "Dropdown"
        choices: ["Mild", "Moderate", "Severe"]
        skipLogic:
          sourceField: "primary_diagnosis"
          operator: "exists"
      - id: "primary_diagnosis"
        path: "Condition.clinicalStatus.coding.code"
        label: "Suspected Acute Traumatic Injury"
        uiComponent: "Autocomplete"
        valueSetUrl: "https://nih.gov"
      - id: "injury_severity"
        path: "Condition.severity.coding.code"
        label: "Trauma Severity Scale Evaluation"
        uiComponent: "Dropdown"
        choices: ["Mild", "Moderate", "Severe"]
        skipLogic:
          sourceField: "primary_diagnosis"
          operator: "exists"
      - id: "primary_diagnosis"
        path: "Condition.clinicalStatus.coding.code"
        label: "Suspected Acute Traumatic Injury"
        uiComponent: "Autocomplete"
        valueSetUrl: "https://nih.gov"
      - id: "injury_severity"
        path: "Condition.severity.coding.code"
        label: "Trauma Severity Scale Evaluation"
        uiComponent: "Dropdown"
        choices: ["Mild", "Moderate", "Severe"]
        skipLogic:
          sourceField: "primary_diagnosis"
          operator: "exists"
      - id: "primary_diagnosis"
        path: "Condition.clinicalStatus.coding.code"
        label: "Suspected Acute Traumatic Injury"
        uiComponent: "Autocomplete"
        valueSetUrl: "https://nih.gov"
      - id: "injury_severity"
        path: "Condition.severity.coding.code"
        label: "Trauma Severity Scale Evaluation"
        uiComponent: "Dropdown"
        choices: ["Mild", "Moderate", "Severe"]
        skipLogic:
          sourceField: "primary_diagnosis"
          operator: "exists"
      - id: "primary_diagnosis"
        path: "Condition.clinicalStatus.coding.code"
        label: "Suspected Acute Traumatic Injury"
        uiComponent: "Autocomplete"
        valueSetUrl: "https://nih.gov"
      - id: "injury_severity"
        path: "Condition.severity.coding.code"
        label: "Trauma Severity Scale Evaluation"
        uiComponent: "Dropdown"
        choices: ["Mild", "Moderate", "Severe"]
        skipLogic:
          sourceField: "primary_diagnosis"
          operator: "exists"
      - id: "primary_diagnosis"
        path: "Condition.clinicalStatus.coding.code"
        label: "Suspected Acute Traumatic Injury"
        uiComponent: "Autocomplete"
        valueSetUrl: "https://nih.gov"
      - id: "injury_severity"
        path: "Condition.severity.coding.code"
        label: "Trauma Severity Scale Evaluation"
        uiComponent: "Dropdown"
        choices: ["Mild", "Moderate", "Severe"]
        skipLogic:
          sourceField: "primary_diagnosis"
          operator: "exists"
      - id: "primary_diagnosis"
        path: "Condition.clinicalStatus.coding.code"
        label: "Suspected Acute Traumatic Injury"
        uiComponent: "Autocomplete"
        valueSetUrl: "https://nih.gov"
      - id: "injury_severity"
        path: "Condition.severity.coding.code"
        label: "Trauma Severity Scale Evaluation"
        uiComponent: "Dropdown"
        choices: ["Mild", "Moderate", "Severe"]
        skipLogic:
          sourceField: "primary_diagnosis"
          operator: "exists"
      - id: "primary_diagnosis"
        path: "Condition.clinicalStatus.coding.code"
        label: "Suspected Acute Traumatic Injury"
        uiComponent: "Autocomplete"
        valueSetUrl: "https://nih.gov"
      - id: "injury_severity"
        path: "Condition.severity.coding.code"
        label: "Trauma Severity Scale Evaluation"
        uiComponent: "Dropdown"
        choices: ["Mild", "Moderate", "Severe"]
        skipLogic:
          sourceField: "primary_diagnosis"
          operator: "exists"
      - id: "primary_diagnosis"
        path: "Condition.clinicalStatus.coding.code"
        label: "Suspected Acute Traumatic Injury"
        uiComponent: "Autocomplete"
        valueSetUrl: "https://nih.gov"
      - id: "injury_severity"
        path: "Condition.severity.coding.code"
        label: "Trauma Severity Scale Evaluation"
        uiComponent: "Dropdown"
        choices: ["Mild", "Moderate", "Severe"]
        skipLogic:
          sourceField: "primary_diagnosis"
          operator: "exists"
      - id: "primary_diagnosis"
        path: "Condition.clinicalStatus.coding.code"
        label: "Suspected Acute Traumatic Injury"
        uiComponent: "Autocomplete"
        valueSetUrl: "https://nih.gov"
      - id: "injury_severity"
        path: "Condition.severity.coding.code"
        label: "Trauma Severity Scale Evaluation"
        uiComponent: "Dropdown"
        choices: ["Mild", "Moderate", "Severe"]
        skipLogic:
          sourceField: "primary_diagnosis"
          operator: "exists"
      - id: "primary_diagnosis"
        path: "Condition.clinicalStatus.coding.code"
        label: "Suspected Acute Traumatic Injury"
        uiComponent: "Autocomplete"
        valueSetUrl: "https://nih.gov"
      - id: "injury_severity"
        path: "Condition.severity.coding.code"
        label: "Trauma Severity Scale Evaluation"
        uiComponent: "Dropdown"
        choices: ["Mild", "Moderate", "Severe"]
        skipLogic:
          sourceField: "primary_diagnosis"
          operator: "exists"
      - id: "primary_diagnosis"
        path: "Condition.clinicalStatus.coding.code"
        label: "Suspected Acute Traumatic Injury"
        uiComponent: "Autocomplete"
        valueSetUrl: "https://nih.gov"
      - id: "injury_severity"
        path: "Condition.severity.coding.code"
        label: "Trauma Severity Scale Evaluation"
        uiComponent: "Dropdown"
        choices: ["Mild", "Moderate", "Severe"]
        skipLogic:
          sourceField: "primary_diagnosis"
          operator: "exists"
      - id: "primary_diagnosis"
        path: "Condition.clinicalStatus.coding.code"
        label: "Suspected Acute Traumatic Injury"
        uiComponent: "Autocomplete"
        valueSetUrl: "https://nih.gov"
      - id: "injury_severity"
        path: "Condition.severity.coding.code"
        label: "Trauma Severity Scale Evaluation"
        uiComponent: "Dropdown"
        choices: ["Mild", "Moderate", "Severe"]
        skipLogic:
          sourceField: "primary_diagnosis"
          operator: "exists"
      - id: "primary_diagnosis"
        path: "Condition.clinicalStatus.coding.code"
        label: "Suspected Acute Traumatic Injury"
        uiComponent: "Autocomplete"
        valueSetUrl: "https://nih.gov"
      - id: "injury_severity"
        path: "Condition.severity.coding.code"
        label: "Trauma Severity Scale Evaluation"
        uiComponent: "Dropdown"
        choices: ["Mild", "Moderate", "Severe"]
        skipLogic:
          sourceField: "primary_diagnosis"
          operator: "exists"
      - id: "primary_diagnosis"
        path: "Condition.clinicalStatus.coding.code"
        label: "Suspected Acute Traumatic Injury"
        uiComponent: "Autocomplete"
        valueSetUrl: "https://nih.gov"
      - id: "injury_severity"
        path: "Condition.severity.coding.code"
        label: "Trauma Severity Scale Evaluation"
        uiComponent: "Dropdown"
        choices: ["Mild", "Moderate", "Severe"]
        skipLogic:
          sourceField: "primary_diagnosis"
          operator: "exists"
      - id: "primary_diagnosis"
        path: "Condition.clinicalStatus.coding.code"
        label: "Suspected Acute Traumatic Injury"
        uiComponent: "Autocomplete"
        valueSetUrl: "https://nih.gov"
      - id: "injury_severity"
        path: "Condition.severity.coding.code"
        label: "Trauma Severity Scale Evaluation"
        uiComponent: "Dropdown"
        choices: ["Mild", "Moderate", "Severe"]
        skipLogic:
          sourceField: "primary_diagnosis"
          operator: "exists"
      - id: "primary_diagnosis"
        path: "Condition.clinicalStatus.coding.code"
        label: "Suspected Acute Traumatic Injury"
        uiComponent: "Autocomplete"
        valueSetUrl: "https://nih.gov"
      - id: "injury_severity"
        path: "Condition.severity.coding.code"
        label: "Trauma Severity Scale Evaluation"
        uiComponent: "Dropdown"
        choices: ["Mild", "Moderate", "Severe"]
        skipLogic:
          sourceField: "primary_diagnosis"
          operator: "exists"
      - id: "primary_diagnosis"
        path: "Condition.clinicalStatus.coding.code"
        label: "Suspected Acute Traumatic Injury"
        uiComponent: "Autocomplete"
        valueSetUrl: "https://nih.gov"
      - id: "injury_severity"
        path: "Condition.severity.coding.code"
        label: "Trauma Severity Scale Evaluation"
        uiComponent: "Dropdown"
        choices: ["Mild", "Moderate", "Severe"]
        skipLogic:
          sourceField: "primary_diagnosis"
          operator: "exists"
      - id: "primary_diagnosis"
        path: "Condition.clinicalStatus.coding.code"
        label: "Suspected Acute Traumatic Injury"
        uiComponent: "Autocomplete"
        valueSetUrl: "https://nih.gov"
      - id: "injury_severity"
        path: "Condition.severity.coding.code"
        label: "Trauma Severity Scale Evaluation"
        uiComponent: "Dropdown"
        choices: ["Mild", "Moderate", "Severe"]
        skipLogic:
          sourceField: "primary_diagnosis"
          operator: "exists"
      - id: "primary_diagnosis"
        path: "Condition.clinicalStatus.coding.code"
        label: "Suspected Acute Traumatic Injury"
        uiComponent: "Autocomplete"
        valueSetUrl: "https://nih.gov"
      - id: "injury_severity"
        path: "Condition.severity.coding.code"
        label: "Trauma Severity Scale Evaluation"
        uiComponent: "Dropdown"
        choices: ["Mild", "Moderate", "Severe"]
        skipLogic:
          sourceField: "primary_diagnosis"
          operator: "exists"
      - id: "primary_diagnosis"
        path: "Condition.clinicalStatus.coding.code"
        label: "Suspected Acute Traumatic Injury"
        uiComponent: "Autocomplete"
        valueSetUrl: "https://nih.gov"
      - id: "injury_severity"
        path: "Condition.severity.coding.code"
        label: "Trauma Severity Scale Evaluation"
        uiComponent: "Dropdown"
        choices: ["Mild", "Moderate", "Severe"]
        skipLogic:
          sourceField: "primary_diagnosis"
          operator: "exists"
      - id: "primary_diagnosis"
        path: "Condition.clinicalStatus.coding.code"
        label: "Suspected Acute Traumatic Injury"
        uiComponent: "Autocomplete"
        valueSetUrl: "https://nih.gov"
      - id: "injury_severity"
        path: "Condition.severity.coding.code"
        label: "Trauma Severity Scale Evaluation"
        uiComponent: "Dropdown"
        choices: ["Mild", "Moderate", "Severe"]
        skipLogic:
          sourceField: "primary_diagnosis"
          operator: "exists"
      - id: "primary_diagnosis"
        path: "Condition.clinicalStatus.coding.code"
        label: "Suspected Acute Traumatic Injury"
        uiComponent: "Autocomplete"
        valueSetUrl: "https://nih.gov"
      - id: "injury_severity"
        path: "Condition.severity.coding.code"
        label: "Trauma Severity Scale Evaluation"
        uiComponent: "Dropdown"
        choices: ["Mild", "Moderate", "Severe"]
        skipLogic:
          sourceField: "primary_diagnosis"
          operator: "exists"
      - id: "primary_diagnosis"
        path: "Condition.clinicalStatus.coding.code"
        label: "Suspected Acute Traumatic Injury"
        uiComponent: "Autocomplete"
        valueSetUrl: "https://nih.gov"
      - id: "injury_severity"
        path: "Condition.severity.coding.code"
        label: "Trauma Severity Scale Evaluation"
        uiComponent: "Dropdown"
        choices: ["Mild", "Moderate", "Severe"]
        skipLogic:
          sourceField: "primary_diagnosis"
          operator: "exists"
      - id: "primary_diagnosis"
        path: "Condition.clinicalStatus.coding.code"
        label: "Suspected Acute Traumatic Injury"
        uiComponent: "Autocomplete"
        valueSetUrl: "https://nih.gov"
      - id: "injury_severity"
        path: "Condition.severity.coding.code"
        label: "Trauma Severity Scale Evaluation"
        uiComponent: "Dropdown"
        choices: ["Mild", "Moderate", "Severe"]
        skipLogic:
          sourceField: "primary_diagnosis"
          operator: "exists"
      - id: "primary_diagnosis"
        path: "Condition.clinicalStatus.coding.code"
        label: "Suspected Acute Traumatic Injury"
        uiComponent: "Autocomplete"
        valueSetUrl: "https://nih.gov"
      - id: "injury_severity"
        path: "Condition.severity.coding.code"
        label: "Trauma Severity Scale Evaluation"
        uiComponent: "Dropdown"
        choices: ["Mild", "Moderate", "Severe"]
        skipLogic:
          sourceField: "primary_diagnosis"
          operator: "exists"
      - id: "primary_diagnosis"
        path: "Condition.clinicalStatus.coding.code"
        label: "Suspected Acute Traumatic Injury"
        uiComponent: "Autocomplete"
        valueSetUrl: "https://nih.gov"
      - id: "injury_severity"
        path: "Condition.severity.coding.code"
        label: "Trauma Severity Scale Evaluation"
        uiComponent: "Dropdown"
        choices: ["Mild", "Moderate", "Severe"]
        skipLogic:
          sourceField: "primary_diagnosis"
          operator: "exists"
      - id: "primary_diagnosis"
        path: "Condition.clinicalStatus.coding.code"
        label: "Suspected Acute Traumatic Injury"
        uiComponent: "Autocomplete"
        valueSetUrl: "https://nih.gov"
      - id: "injury_severity"
        path: "Condition.severity.coding.code"
        label: "Trauma Severity Scale Evaluation"
        uiComponent: "Dropdown"
        choices: ["Mild", "Moderate", "Severe"]
        skipLogic:
          sourceField: "primary_diagnosis"
          operator: "exists"
      - id: "primary_diagnosis"
        path: "Condition.clinicalStatus.coding.code"
        label: "Suspected Acute Traumatic Injury"
        uiComponent: "Autocomplete"
        valueSetUrl: "https://nih.gov"
      - id: "injury_severity"
        path: "Condition.severity.coding.code"
        label: "Trauma Severity Scale Evaluation"
        uiComponent: "Dropdown"
        choices: ["Mild", "Moderate", "Severe"]
        skipLogic:
          sourceField: "primary_diagnosis"
          operator: "exists"
      - id: "primary_diagnosis"
        path: "Condition.clinicalStatus.coding.code"
        label: "Suspected Acute Traumatic Injury"
        uiComponent: "Autocomplete"
        valueSetUrl: "https://nih.gov"
      - id: "injury_severity"
        path: "Condition.severity.coding.code"
        label: "Trauma Severity Scale Evaluation"
        uiComponent: "Dropdown"
        choices: ["Mild", "Moderate", "Severe"]
        skipLogic:
          sourceField: "primary_diagnosis"
          operator: "exists"
      - id: "primary_diagnosis"
        path: "Condition.clinicalStatus.coding.code"
        label: "Suspected Acute Traumatic Injury"
        uiComponent: "Autocomplete"
        valueSetUrl: "https://nih.gov"
      - id: "injury_severity"
        path: "Condition.severity.coding.code"
        label: "Trauma Severity Scale Evaluation"
        uiComponent: "Dropdown"
        choices: ["Mild", "Moderate", "Severe"]
        skipLogic:
          sourceField: "primary_diagnosis"
          operator: "exists"
      - id: "primary_diagnosis"
        path: "Condition.clinicalStatus.coding.code"
        label: "Suspected Acute Traumatic Injury"
        uiComponent: "Autocomplete"
        valueSetUrl: "https://nih.gov"
      - id: "injury_severity"
        path: "Condition.severity.coding.code"
        label: "Trauma Severity Scale Evaluation"
        uiComponent: "Dropdown"
        choices: ["Mild", "Moderate", "Severe"]
        skipLogic:
          sourceField: "primary_diagnosis"
          operator: "exists"
       ');
INSERT INTO room_workflows (room_id, role, specialty, yaml_payload) VALUES ('diabetes-chronic-review-v1', 'Architect', 'Cardiology', 'formId: diabetes-chronic-review-v1
title: "Comprehensive Metabolic & Endocrine Tracking Protocol"
composition:
  - resourceType: Patient
    id: section_demographics
    label: "1. Core Demographics"
    fields:
      - id: "patient_gender"
        path: "Patient.gender"
        label: "Biological Sex at Birth"
        uiComponent: "Dropdown"
        choices: ["male", "female", "other"]
  - resourceType: Observation
    id: section_metabolic_labs
    label: "2. Glycemic & Renal Metrics Matrix"
    itemControl: "gtable"
    repeats: true
    fields:
      - id: "hba1c_level"
        path: "Observation.component.valueQuantity.value"
        label: "Hemoglobin A1c Value"
        uiComponent: "NumericInput"
        unit: "%"
        required: true
      - id: "fasting_glucose"
        path: "Observation.component.valueQuantity.value"
        label: "Fasting Plasma Glucose Metrics"
        uiComponent: "NumericInput"
        unit: "mg/dL"
  - resourceType: Condition
    id: section_complications
    label: "3. Secondary Complications"
    fields:
      - id: "complication_search"
        path: "Condition.clinicalStatus.coding.code"
        label: "Active Secondary Endocrine Complication"
        uiComponent: "Autocomplete"
        valueSetUrl: "https://nih.gov"
  - resourceType: MedicationRequest
    id: section_pharmacotherapy
    label: "4. Adjusted Prescription Registry"
    fields:
      - id: "primary_anti_hyperglycemic"
        path: "MedicationRequest.medicationCodeableConcept.coding.code"
        label: "Search Prescribed Diabetes Management Medication"
        uiComponent: "Autocomplete"
        valueSetUrl: "https://clinicaltables.nlm.nih.gov/fhir/R4/ValueSet/rxterms" 
        helpText: "Begin typing medication names to search RxNorm database tables"
');
INSERT INTO room_workflows (room_id, role, specialty, yaml_payload) VALUES ('clinic-corporate-onboarding-v1', 'Architect', 'Cardiology', 'formId: clinic-corporate-onboarding-v1
title: "Clinic Facility Infrastructure Registration"
composition:
  - resourceType: Organization
    id: section_organization_profile
    label: "1. Legal Entity & Corporate Registration"
    fields:
      - id: "org_legal_name"
        path: "Organization.name"
        label: "Official Corporate Name"
        description: "The primary registered commercial name of the medical practice or corporate group entity."
        uiComponent: "TextInput"
        required: true
      - id: "org_tax_identifier"
        path: "Organization.identifier.value"
        label: "Practice Corporate Tax ID"
        description: "The official federal business tax registration number or employer identification token code."
        uiComponent: "TextInput"
        required: true

  - resourceType: Location
    id: section_branch_location
    label: "2. Physical Facility Operating Branch"
    fields:
      - id: "loc_facility_name"
        path: "Location.name"
        label: "Clinic Branch Nickname"
        description: "The custom moniker or name distinguishing this specific physical office location branch."
        uiComponent: "TextInput"
        required: true
      - id: "loc_postal_address"
        path: "Location.address.text"
        label: "Complete Facility Physical Address"
        description: "The complete geographical street, postal code, and routing address for patient check-ins."
        uiComponent: "TextInput"
        required: true
');
INSERT INTO room_workflows (room_id, role, specialty, yaml_payload) VALUES ('clinic-personnel-onboarding-v1', 'Architect', 'Cardiology', 'formId: clinic-personnel-onboarding-v1
title: "Staff and Care Team Personnel Onboarding"
composition:
  - resourceType: Practitioner
    id: section_staff_demographics
    label: "1. Personnel Demographic Registry"
    fields:
      - id: "staff_full_name"
        path: "Practitioner.name.text"
        label: "Full Legal Name"
        description: "The full legal name of the clinical provider, administrative worker, or financial staff member."
        uiComponent: "TextInput"
        required: true

  - resourceType: PractitionerRole
    id: section_staff_assignment
    label: "2. Care Team Operational Role and Scope"
    fields:
      - id: "staff_role_classification"
        path: "PractitionerRole.code.coding.code"
        label: "Staff Persona Classification"
        description: "The designated administrative or medical role type describing this staff profile''s room access scope."
        uiComponent: "Dropdown"
        choices: ["Physician", "Nurse", "Radiologist", "Front Desk Admin", "Finance Officer", "Pharmacist"]
        required: true
      - id: "staff_specialty_multi"
        path: "PractitionerRole.specialty.coding.code"
        label: "Assigned Functional Specialties"
        description: "The specific clinical focus areas or skill tracks attached to this user account profile configuration."
        uiComponent: "MultiSelect"
        choices: ["Cardiology", "Neurology", "Triage Intake", "Medical Billing", "Inventory Control"]
');
INSERT INTO room_workflows (room_id, role, specialty, yaml_payload) VALUES ('advanced-clinical-matrix-v1', 'Architect', 'Cardiology', 'formId: advanced-clinical-matrix-v1
title: "Comprehensive Multi-Specialty Examination Layout"
composition:
  - resourceType: Patient
    id: section_demographics
    label: "1. Administrative Demographics"
    fields:
      - id: "patient_gender" 
        path: "Patient.gender"
        label: "Biological Sex at Birth"
        uiComponent: "Dropdown"
        choices: ["male", "female", "other", "unknown"]
        required: true
  - resourceType: Observation
    id: section_vitals
    label: "2. Patient Vitals Matrix"
    type: "group"
    itemControl: "gtable"
    repeats: true
    fields:
      - id: "systolic_bp" 
        path: "Observation.component.valueQuantity.value"
        label: "Systolic Blood Pressure"
        uiComponent: "NumericInput"
        unit: "mm[Hg]"
        required: true
      - id: "diastolic_bp"
        path: "Observation.component.valueQuantity.value"
        label: "Diastolic Blood Pressure"
        uiComponent: "NumericInput"
        unitChoices: ["mm[Hg]", "kPa"]
  - resourceType: Condition
    id: section_clinical
    label: "3. Diagnostic Findings & Diagnostics"
    fields:
      - id: "condition_search" 
        path: "Condition.clinicalStatus.coding.code" # Update to match your exact grep output string
        label: "Search Confirmed Diagnosis"
        uiComponent: "Autocomplete"
        valueSetUrl: "https://clinicaltables.nlm.nih.gov/fhir/R4/ValueSet/conditions" 
        helpText: "Begin typing clinical terms to search SNOMED-CT database tables."
      - id: "condition_severity"
        path: "Condition.severity.coding.code" # Update to match your exact grep output string
        label: "Clinical Severity Scaling"
        uiComponent: "Dropdown"
        choices: ["Mild", "Moderate", "Severe"]
        skipLogic:
          sourceField: "condition_search" # Must match the updated source path string
          operator: "exists"
  - resourceType: MedicationRequest
    id: section_medications
    label: "4. Medication Management & Prescriptions"
    fields:
      - id: "medication_search" 
        path: "MedicationRequest.medicationCodeableConcept.coding.code"
        label: "Search Prescribed Medications"
        uiComponent: "Autocomplete"
        valueSetUrl: "https://clinicaltables.nlm.nih.gov/fhir/R4/ValueSet/rxterms" 
        helpText: "Begin typing medication names to search RxNorm database tables"

');
INSERT INTO local_holding_queue (session_id, room_id, raw_transcript, questionnaire_response_json, status, captured_at) VALUES ('sess-1783168921218', 'Questionnaire/advanced-clinical-matrix-v1', 'Patient is a female presenting in clinic today. Checked vitals showing stable systolic metrics tracking around 148.', '{"resourceType":"QuestionnaireResponse","questionnaire":"Questionnaire/advanced-clinical-matrix-v1","status":"completed","item":[{"linkId":"section_demographics","text":"1. Administrative Demographics","item":[{"linkId":"Patient.gender","text":"Biological Sex at Birth","answer":[{"valueString":"female"}]}]},{"linkId":"section_vitals","text":"2. Patient Vitals Matrix","item":[{"linkId":"Observation.component.valueQuantity.value","text":"Systolic Blood Pressure","answer":[{"valueDecimal":148}]},{"linkId":"Observation.component.valueQuantity.value","text":"Diastolic Blood Pressure","answer":[{"valueDecimal":148}]}]},{"linkId":"section_clinical","text":"3. Diagnostic Findings & Diagnostics","item":[{"linkId":"Condition.clinicalStatus.coding.code","text":"Search Confirmed Diagnosis","answer":[{"valueString":"active-hypertension"}]}]}]}', 'pending_review', '2026-07-04T12:42:01.218Z');
INSERT INTO local_holding_queue (session_id, room_id, raw_transcript, questionnaire_response_json, status, captured_at) VALUES ('sess-1783171798514', 'Questionnaire/advanced-clinical-matrix-v1', 'Patient is a female presenting in clinic today. Checked vitals showing stable systolic metrics tracking around 148.', '{"resourceType":"QuestionnaireResponse","questionnaire":"Questionnaire/advanced-clinical-matrix-v1","status":"completed","item":[{"linkId":"section_demographics","text":"1. Administrative Demographics","item":[{"linkId":"Patient.gender","text":"Biological Sex at Birth","answer":[{"valueString":"female"}]}]},{"linkId":"section_vitals","text":"2. Patient Vitals Matrix","item":[{"linkId":"Observation.component.valueQuantity.value","text":"Systolic Blood Pressure","answer":[{"valueDecimal":148}]},{"linkId":"Observation.component.valueQuantity.value","text":"Diastolic Blood Pressure","answer":[{"valueDecimal":148}]}]},{"linkId":"section_clinical","text":"3. Diagnostic Findings & Diagnostics","item":[{"linkId":"Condition.clinicalStatus.coding.code","text":"Search Confirmed Diagnosis","answer":[{"valueString":"active-hypertension"}]}]}]}', 'pending_review', '2026-07-04T13:29:58.514Z');
INSERT INTO local_holding_queue (session_id, room_id, raw_transcript, questionnaire_response_json, status, captured_at) VALUES ('sess-1783172285416', 'Questionnaire/advanced-clinical-matrix-v1', 'Patient is a female presenting in clinic today. Checked vitals showing stable systolic metrics tracking around 148.', '{"resourceType":"QuestionnaireResponse","questionnaire":"Questionnaire/advanced-clinical-matrix-v1","status":"completed","item":[{"linkId":"section_demographics","text":"1. Administrative Demographics","item":[{"linkId":"Patient.gender","text":"Biological Sex at Birth","answer":[{"valueString":"female"}]}]},{"linkId":"section_vitals","text":"2. Patient Vitals Matrix","item":[{"linkId":"Observation.component.valueQuantity.value","text":"Systolic Blood Pressure","answer":[{"valueDecimal":148}]},{"linkId":"Observation.component.valueQuantity.value","text":"Diastolic Blood Pressure","answer":[{"valueDecimal":148}]}]},{"linkId":"section_clinical","text":"3. Diagnostic Findings & Diagnostics","item":[{"linkId":"Condition.clinicalStatus.coding.code","text":"Search Confirmed Diagnosis","answer":[{"valueString":"active-hypertension"}]}]}]}', 'pending_review', '2026-07-04T13:38:05.416Z');
INSERT INTO local_holding_queue (session_id, room_id, raw_transcript, questionnaire_response_json, status, captured_at) VALUES ('sess-1783177794583', 'Questionnaire/advanced-clinical-matrix-v1', 'Patient is a female presenting in clinic today. Checked vitals showing stable systolic metrics tracking around 148.', '{"resourceType":"QuestionnaireResponse","questionnaire":"Questionnaire/advanced-clinical-matrix-v1","status":"completed","item":[{"linkId":"section_demographics","text":"1. Administrative Demographics","item":[{"linkId":"Patient.gender","text":"Biological Sex at Birth","answer":[{"valueString":"female"}]}]},{"linkId":"section_vitals","text":"2. Patient Vitals Matrix","item":[{"linkId":"Observation.component.valueQuantity.value","text":"Systolic Blood Pressure","answer":[{"valueDecimal":148}]},{"linkId":"Observation.component.valueQuantity.value","text":"Diastolic Blood Pressure","answer":[{"valueDecimal":148}]}]},{"linkId":"section_clinical","text":"3. Diagnostic Findings & Diagnostics","item":[{"linkId":"Condition.clinicalStatus.coding.code","text":"Search Confirmed Diagnosis","answer":[{"valueString":"active-hypertension"}]}]}]}', 'pending_review', '2026-07-04T15:09:54.583Z');
INSERT INTO local_holding_queue (session_id, room_id, raw_transcript, questionnaire_response_json, status, captured_at) VALUES ('sess-1783178920571', 'Questionnaire/advanced-clinical-matrix-v1', 'Patient is a female presenting in clinic today. Checked vitals showing stable systolic metrics tracking around 148.', '{"resourceType":"QuestionnaireResponse","questionnaire":"Questionnaire/advanced-clinical-matrix-v1","status":"completed","item":[{"linkId":"section_demographics","text":"1. Administrative Demographics","item":[{"linkId":"Patient.gender","text":"Biological Sex at Birth","answer":[{"valueString":"female"}]}]},{"linkId":"section_vitals","text":"2. Patient Vitals Matrix","item":[{"linkId":"Observation.component.valueQuantity.value","text":"Systolic Blood Pressure","answer":[{"valueDecimal":148}]},{"linkId":"Observation.component.valueQuantity.value","text":"Diastolic Blood Pressure","answer":[{"valueDecimal":148}]}]},{"linkId":"section_clinical","text":"3. Diagnostic Findings & Diagnostics","item":[{"linkId":"Condition.clinicalStatus.coding.code","text":"Search Confirmed Diagnosis","answer":[{"valueString":"active-hypertension"}]}]}]}', 'pending_review', '2026-07-04T15:28:40.571Z');
INSERT INTO local_holding_queue (session_id, room_id, raw_transcript, questionnaire_response_json, status, captured_at) VALUES ('sess-1783179797472', 'Questionnaire/advanced-clinical-matrix-v1', 'Patient is a female presenting in clinic today. Checked vitals showing stable systolic metrics tracking around 148.', '{"resourceType":"QuestionnaireResponse","questionnaire":"Questionnaire/advanced-clinical-matrix-v1","status":"completed","item":[{"linkId":"section_demographics","text":"1. Administrative Demographics","item":[{"linkId":"Patient.gender","text":"Biological Sex at Birth","answer":[{"valueString":"female"}]}]},{"linkId":"section_vitals","text":"2. Patient Vitals Matrix","item":[{"linkId":"Observation.component.valueQuantity.value","text":"Systolic Blood Pressure","answer":[{"valueDecimal":148}]},{"linkId":"Observation.component.valueQuantity.value","text":"Diastolic Blood Pressure","answer":[{"valueDecimal":148}]}]},{"linkId":"section_clinical","text":"3. Diagnostic Findings & Diagnostics","item":[{"linkId":"Condition.clinicalStatus.coding.code","text":"Search Confirmed Diagnosis","answer":[{"valueString":"active-hypertension"}]}]}]}', 'pending_review', '2026-07-04T15:43:17.472Z');
INSERT INTO local_holding_queue (session_id, room_id, raw_transcript, questionnaire_response_json, status, captured_at) VALUES ('sess-1783180266303', 'Questionnaire/advanced-clinical-matrix-v1', 'Patient is a female presenting in clinic today. Checked vitals showing stable systolic metrics tracking around 148.', '{"resourceType":"QuestionnaireResponse","questionnaire":"Questionnaire/advanced-clinical-matrix-v1","status":"completed","item":[{"linkId":"section_demographics","text":"1. Administrative Demographics","item":[{"linkId":"Patient.gender","text":"Biological Sex at Birth","answer":[{"valueString":"female"}]}]},{"linkId":"section_clinical","text":"3. Diagnostic Findings & Diagnostics","item":[{"linkId":"Condition.clinicalStatus.coding.code","text":"Search Confirmed Diagnosis","answer":[{"valueString":"active-hypertension"}]}]}]}', 'pending_review', '2026-07-04T15:51:06.303Z');
INSERT INTO local_holding_queue (session_id, room_id, raw_transcript, questionnaire_response_json, status, captured_at) VALUES ('sess-1783180433835', 'advanced-clinical-matrix-v1', 'Patient is a female presenting in clinic today. Checked vitals showing stable systolic metrics tracking around 148.', '{"resourceType":"QuestionnaireResponse","questionnaire":"Questionnaire/advanced-clinical-matrix-v1","status":"completed","item":[{"linkId":"section_vitals","text":"2. Patient Vitals Matrix","item":[{"linkId":"systolic_bp","text":"Systolic Blood Pressure","answer":[{"valueDecimal":148}]},{"linkId":"diastolic_bp","text":"Diastolic Blood Pressure","answer":[{"valueDecimal":89}]}]}]}', 'pending_review', '2026-07-04T15:53:53.836Z');
INSERT INTO local_holding_queue (session_id, room_id, raw_transcript, questionnaire_response_json, status, captured_at) VALUES ('sess-1783180993918', 'advanced-clinical-matrix-v1', 'Patient is a female presenting in clinic today. Checked vitals showing stable systolic metrics tracking around 148.', '{"resourceType":"QuestionnaireResponse","questionnaire":"Questionnaire/advanced-clinical-matrix-v1","status":"completed","item":[{"linkId":"section_demographics","text":"1. Administrative Demographics","item":[{"linkId":"patient_gender","text":"Biological Sex at Birth","answer":[{"valueString":"female"}]}]},{"linkId":"section_vitals","text":"2. Patient Vitals Matrix","item":[{"linkId":"systolic_bp","text":"Systolic Blood Pressure","answer":[{"valueDecimal":148}]},{"linkId":"diastolic_bp","text":"Diastolic Blood Pressure","answer":[{"valueDecimal":89}]}]},{"linkId":"section_clinical","text":"3. Diagnostic Findings & Diagnostics","item":[{"linkId":"condition_search","text":"Search Confirmed Diagnosis","answer":[{"valueString":"active-hypertension"}]}]}]}', 'pending_review', '2026-07-04T16:03:13.918Z');
INSERT INTO local_holding_queue (session_id, room_id, raw_transcript, questionnaire_response_json, status, captured_at) VALUES ('sess-1783187843393', 'advanced-clinical-matrix-v1', 'Patient is a female presenting in clinic today. Checked vitals showing stable systolic metrics tracking around 148.', '{"resourceType":"QuestionnaireResponse","questionnaire":"Questionnaire/advanced-clinical-matrix-v1","status":"completed","item":[]}', 'pending_review', '2026-07-04T17:57:23.394Z');
INSERT INTO local_holding_queue (session_id, room_id, raw_transcript, questionnaire_response_json, status, captured_at) VALUES ('sess-1783188096526', 'advanced-clinical-matrix-v1', 'Patient is a female presenting in clinic today. Checked vitals showing stable systolic metrics tracking around 148.', '{"resourceType":"QuestionnaireResponse","questionnaire":"Questionnaire/advanced-clinical-matrix-v1","status":"completed","item":[{"linkId":"section_demographics","text":"1. Administrative Demographics","item":[{"linkId":"patient_gender","text":"Biological Sex at Birth","answer":[{"valueString":"female"}]}]},{"linkId":"section_vitals","text":"2. Patient Vitals Matrix","item":[{"linkId":"systolic_bp","text":"Systolic Blood Pressure","answer":[{"valueDecimal":148}]}]}]}', 'pending_review', '2026-07-04T18:01:36.526Z');
INSERT INTO local_holding_queue (session_id, room_id, raw_transcript, questionnaire_response_json, status, captured_at) VALUES ('sess-1783188247454', 'advanced-clinical-matrix-v1', 'Patient is a female presenting in clinic today. Checked vitals showing stable diastolic metrics tracking, but an advanced systolic reading of 148. She has an active history of chronic hypertension. For management, we are initiating a new prescription order for oral tablet Lisinopril 10mg.', '{"resourceType":"QuestionnaireResponse","questionnaire":"Questionnaire/advanced-clinical-matrix-v1","status":"completed","item":[{"linkId":"section_demographics","text":"1. Administrative Demographics","item":[{"linkId":"patient_gender","text":"Biological Sex at Birth","answer":[{"valueString":"female"}]}]},{"linkId":"section_vitals","text":"2. Patient Vitals Matrix","item":[{"linkId":"systolic_bp","text":"Systolic Blood Pressure","answer":[{"valueDecimal":148}]},{"linkId":"diastolic_bp","text":"Diastolic Blood Pressure","answer":[{"valueString":"stable"}]}]}]}', 'pending_review', '2026-07-04T18:04:07.454Z');
INSERT INTO local_holding_queue (session_id, room_id, raw_transcript, questionnaire_response_json, status, captured_at) VALUES ('sess-1783188431891', 'advanced-clinical-matrix-v1', 'Patient is a female presenting in clinic today. Checked vitals showing stable systolic metrics tracking around 148.', '{"resourceType":"QuestionnaireResponse","questionnaire":"Questionnaire/advanced-clinical-matrix-v1","status":"completed","item":[]}', 'pending_review', '2026-07-04T18:07:11.891Z');
INSERT INTO local_holding_queue (session_id, room_id, raw_transcript, questionnaire_response_json, status, captured_at) VALUES ('sess-1783221333649', 'advanced-clinical-matrix-v1', 'Patient is a female presenting in clinic today. Checked vitals showing stable systolic metrics tracking around 148.', '{"resourceType":"QuestionnaireResponse","questionnaire":"Questionnaire/advanced-clinical-matrix-v1","status":"completed","item":[]}', 'pending_review', '2026-07-05T03:15:33.649Z');
INSERT INTO local_holding_queue (session_id, room_id, raw_transcript, questionnaire_response_json, status, captured_at) VALUES ('sess-1783221393337', 'advanced-clinical-matrix-v1', 'Patient is a female presenting in clinic today. Checked vitals showing stable diastolic metrics tracking, but an advanced systolic reading of 148. She has an active history of chronic hypertension. For management, we are initiating a new prescription order for oral tablet Lisinopril 10mg.', '{"resourceType":"QuestionnaireResponse","questionnaire":"Questionnaire/advanced-clinical-matrix-v1","status":"completed","item":[]}', 'pending_review', '2026-07-05T03:16:33.337Z');
INSERT INTO local_holding_queue (session_id, room_id, raw_transcript, questionnaire_response_json, status, captured_at) VALUES ('sess-1783222238374', 'advanced-clinical-matrix-v1', 'Patient is a female presenting in clinic today. Checked vitals showing stable diastolic metrics tracking, but an advanced systolic reading of 148. She has an active history of chronic hypertension. For management, we are initiating a new prescription order for oral tablet Lisinopril 10mg.', '{"resourceType":"QuestionnaireResponse","questionnaire":"Questionnaire/advanced-clinical-matrix-v1","status":"completed","item":[]}', 'pending_review', '2026-07-05T03:30:38.374Z');
INSERT INTO local_holding_queue (session_id, room_id, raw_transcript, questionnaire_response_json, status, captured_at) VALUES ('sess-1783226339733', 'advanced-clinical-matrix-v1', 'Patient is a female presenting in clinic today. Checked vitals showing stable systolic metrics tracking around 148.', '{"resourceType":"QuestionnaireResponse","questionnaire":"Questionnaire/advanced-clinical-matrix-v1","status":"completed","item":[{"linkId":"section_demographics","text":"1. Administrative Demographics","item":[{"linkId":"patient_gender","text":"Biological Sex at Birth","answer":[{"valueString":"female"}]}]},{"linkId":"section_vitals","text":"2. Patient Vitals Matrix","item":[{"linkId":"systolic_bp","text":"Systolic Blood Pressure","answer":[{"valueDecimal":148}]}]}]}', 'pending_review', '2026-07-05T04:38:59.733Z');
INSERT INTO local_holding_queue (session_id, room_id, raw_transcript, questionnaire_response_json, status, captured_at) VALUES ('sess-1783226530493', 'advanced-clinical-matrix-v1', 'Patient is a female presenting in clinic today. Checked vitals showing stable diastolic metrics tracking, but an advanced systolic reading of 148. She has an active history of chronic hypertension. For management, we are initiating a new prescription order for oral tablet Lisinopril 10mg.', '{"resourceType":"QuestionnaireResponse","questionnaire":"Questionnaire/advanced-clinical-matrix-v1","status":"completed","item":[{"linkId":"section_demographics","text":"1. Administrative Demographics","item":[{"linkId":"patient_gender","text":"Biological Sex at Birth","answer":[{"valueString":"female"}]}]},{"linkId":"section_vitals","text":"2. Patient Vitals Matrix","item":[{"linkId":"systolic_bp","text":"Systolic Blood Pressure","answer":[{"valueDecimal":148}]}]}]}', 'pending_review', '2026-07-05T04:42:10.494Z');
INSERT INTO local_holding_queue (session_id, room_id, raw_transcript, questionnaire_response_json, status, captured_at) VALUES ('sess-1783227297800', 'advanced-clinical-matrix-v1', 'Patient is a female presenting in clinic today. Checked vitals showing stable diastolic metrics tracking, but an advanced systolic reading of 148. She has an active history of chronic hypertension. For management, we are initiating a new prescription order for oral tablet Lisinopril 10mg.', '{"resourceType":"QuestionnaireResponse","questionnaire":"Questionnaire/advanced-clinical-matrix-v1","status":"completed","item":[{"linkId":"section_demographics","text":"1. Administrative Demographics","item":[{"linkId":"patient_gender","text":"Biological Sex at Birth","answer":[{"valueString":"female"}]}]},{"linkId":"section_vitals","text":"2. Patient Vitals Matrix","item":[{"linkId":"systolic_bp","text":"Systolic Blood Pressure","answer":[{"valueDecimal":148}]}]}]}', 'pending_review', '2026-07-05T04:54:57.800Z');
INSERT INTO local_holding_queue (session_id, room_id, raw_transcript, questionnaire_response_json, status, captured_at) VALUES ('sess-1783227578479', 'advanced-clinical-matrix-v1', 'Patient is a female presenting in clinic today. Checked vitals showing stable diastolic metrics tracking, but an advanced systolic reading of 148. She has an active history of chronic hypertension. For management, we are initiating a new prescription order for oral tablet Lisinopril 10mg.', '{"resourceType":"QuestionnaireResponse","questionnaire":"Questionnaire/advanced-clinical-matrix-v1","status":"completed","item":[{"linkId":"section_demographics","text":"1. Administrative Demographics","item":[{"linkId":"patient_gender","text":"Biological Sex at Birth","answer":[{"valueString":"female"}]}]},{"linkId":"section_vitals","text":"2. Patient Vitals Matrix","item":[{"linkId":"systolic_bp","text":"Systolic Blood Pressure","answer":[{"valueDecimal":148}]}]}]}', 'pending_review', '2026-07-05T04:59:38.479Z');
INSERT INTO local_holding_queue (session_id, room_id, raw_transcript, questionnaire_response_json, status, captured_at) VALUES ('sess-1783227756029', 'advanced-clinical-matrix-v1', 'Patient is a female presenting in clinic today. Checked vitals showing stable diastolic metrics tracking, but an advanced systolic reading of 148. She has an active history of chronic hypertension. For management, we are initiating a new prescription order for oral tablet Lisinopril 10mg.', '{"resourceType":"QuestionnaireResponse","questionnaire":"Questionnaire/advanced-clinical-matrix-v1","status":"completed","item":[{"linkId":"section_demographics","text":"1. Administrative Demographics","item":[{"linkId":"patient_gender","text":"Biological Sex at Birth","answer":[{"valueString":"female"}]}]},{"linkId":"section_vitals","text":"2. Patient Vitals Matrix","item":[{"linkId":"systolic_bp","text":"Systolic Blood Pressure","answer":[{"valueDecimal":148}]}]}]}', 'pending_review', '2026-07-05T05:02:36.030Z');
INSERT INTO local_holding_queue (session_id, room_id, raw_transcript, questionnaire_response_json, status, captured_at) VALUES ('sess-1783227879837', 'advanced-clinical-matrix-v1', 'Patient is a female presenting in clinic today. Checked vitals showing stable diastolic metrics tracking, but an advanced systolic reading of 148. She has an active history of chronic hypertension. For management, we are initiating a new prescription order for oral tablet Lisinopril 10mg.', '{"resourceType":"QuestionnaireResponse","questionnaire":"Questionnaire/advanced-clinical-matrix-v1","status":"completed","item":[{"linkId":"section_demographics","text":"1. Administrative Demographics","item":[{"linkId":"patient_gender","text":"Biological Sex at Birth","answer":[{"valueString":"female"}]}]},{"linkId":"section_vitals","text":"2. Patient Vitals Matrix","item":[{"linkId":"systolic_bp","text":"Systolic Blood Pressure","answer":[{"valueDecimal":148}]}]}]}', 'pending_review', '2026-07-05T05:04:39.838Z');
INSERT INTO local_holding_queue (session_id, room_id, raw_transcript, questionnaire_response_json, status, captured_at) VALUES ('sess-1783228254322', 'advanced-clinical-matrix-v1', 'Patient is a female presenting in clinic today. Checked vitals showing stable diastolic metrics tracking, but an advanced systolic reading of 148. She has an active history of chronic hypertension. For management, we are initiating a new prescription order for oral tablet lisinopril 10mg.', '{"resourceType":"QuestionnaireResponse","questionnaire":"Questionnaire/advanced-clinical-matrix-v1","status":"completed","item":[{"linkId":"section_demographics","text":"1. Administrative Demographics","item":[{"linkId":"patient_gender","text":"Biological Sex at Birth","answer":[{"valueString":"female"}]}]},{"linkId":"section_vitals","text":"2. Patient Vitals Matrix","item":[{"linkId":"systolic_bp","text":"Systolic Blood Pressure","answer":[{"valueDecimal":148}]}]},{"linkId":"section_clinical","text":"3. Diagnostic Findings & Diagnostics","item":[{"linkId":"condition_search","text":"Search Confirmed Diagnosis","answer":[{"valueString":"hypertension"}]}]},{"linkId":"section_medications","text":"4. Medication Management & Prescriptions","item":[{"linkId":"medication_search","text":"Search Prescribed Medications","answer":[{"valueString":"lisinopril"}]}]}]}', 'pending_review', '2026-07-05T05:10:54.322Z');
INSERT INTO local_holding_queue (session_id, room_id, raw_transcript, questionnaire_response_json, status, captured_at) VALUES ('sess-1783228890015', 'emergency-triage-matrix-v1', 'We have an incoming motor vehicle collision trauma activation. We are currently in-progress with the resuscitation assessment inside Bay 2. Patient is tachycardic, hook him up to the monitor... okay, heart rate is tracking high at 124 beats per minute. Check his pulse ox... oxygen saturation is sitting low at 89 percent on room air, get him some supplemental flow. There is an obvious structural deformity to the right lower extremity; let''s record the primary traumatic diagnosis as a compound femur fracture. Mark the severity scale on that leg injury as severe."', '{"resourceType":"QuestionnaireResponse","questionnaire":"Questionnaire/emergency-triage-matrix-v1","status":"completed","item":[]}', 'pending_review', '2026-07-05T05:21:30.015Z');
INSERT INTO local_holding_queue (session_id, room_id, raw_transcript, questionnaire_response_json, status, captured_at) VALUES ('sess-1783229429479', 'advanced-clinical-matrix-v1', 'Patient is a female presenting in clinic today. Checked vitals showing stable diastolic metrics tracking, but an advanced systolic reading of 148. She has an active history of chronic hypertension. For management, we are initiating a new prescription order for oral tablet lisinopril 10mg.', '{"resourceType":"QuestionnaireResponse","questionnaire":"Questionnaire/advanced-clinical-matrix-v1","status":"completed","item":[{"linkId":"section_demographics","text":"1. Administrative Demographics","item":[{"linkId":"patient_gender","text":"Biological Sex at Birth","answer":[{"valueString":"female"}]}]},{"linkId":"section_vitals","text":"2. Patient Vitals Matrix","item":[{"linkId":"systolic_bp","text":"Systolic Blood Pressure","answer":[{"valueDecimal":148}]}]},{"linkId":"section_clinical","text":"3. Diagnostic Findings & Diagnostics","item":[{"linkId":"condition_search","text":"Search Confirmed Diagnosis","answer":[{"valueString":"hypertension"}]}]},{"linkId":"section_medications","text":"4. Medication Management & Prescriptions","item":[{"linkId":"medication_search","text":"Search Prescribed Medications","answer":[{"valueString":"lisinopril"}]}]}]}', 'pending_review', '2026-07-05T05:30:29.479Z');
INSERT INTO local_holding_queue (session_id, room_id, raw_transcript, questionnaire_response_json, status, captured_at) VALUES ('sess-1783229497870', 'emergency-triage-matrix-v1', 'We have an incoming motor vehicle collision trauma activation. We are currently in-progress with the resuscitation assessment inside Bay 2. Patient is tachycardic, hook him up to the monitor... okay, heart rate is tracking high at 124 beats per minute. Check his pulse ox... oxygen saturation is sitting low at 89 percent on room air, get him some supplemental flow. There is an obvious structural deformity to the right lower extremity; let''s record the primary traumatic diagnosis as a compound femur fracture. Mark the severity scale on that leg injury as severe.', '{"resourceType":"QuestionnaireResponse","questionnaire":"Questionnaire/emergency-triage-matrix-v1","status":"completed","item":[{"linkId":"section_encounter","text":"1. Triage Classification","item":[{"linkId":"triage_acuity","text":"Acuity Level Assignment","answer":[{"valueString":"124"}]}]},{"linkId":"section_trauma_vitals","text":"2. Resuscitation Hemodynamics","item":[{"linkId":"heart_rate","text":"Heart Rate Metrics","answer":[{"valueDecimal":124}]},{"linkId":"oxygen_saturation","text":"Peripheral Oxygen Saturation","answer":[{"valueDecimal":89}]}]},{"linkId":"section_acute_findings","text":"3. Traumatic Diagnostic Findings","item":[{"linkId":"primary_diagnosis","text":"Suspected Acute Traumatic Injury","answer":[{"valueString":"right lower extremity"}]},{"linkId":"injury_severity","text":"Trauma Severity Scale Evaluation","answer":[{"valueString":"severe"}]}]}]}', 'pending_review', '2026-07-05T05:31:37.870Z');
INSERT INTO local_holding_queue (session_id, room_id, raw_transcript, questionnaire_response_json, status, captured_at) VALUES ('sess-1783437667570', 'advanced-clinical-matrix-v1', 'Patient is a female presenting in clinic today. Checked vitals showing stable diastolic metrics tracking, but an advanced systolic reading of 148. She has an active history of chronic hypertension. For management, we are initiating a new prescription order for oral tablet lisinopril 10mg.', '{"resourceType":"QuestionnaireResponse","questionnaire":"Questionnaire/advanced-clinical-matrix-v1","status":"completed","item":[{"linkId":"section_demographics","text":"1. Administrative Demographics","item":[{"linkId":"patient_gender","text":"Biological Sex at Birth","answer":[{"valueString":"female"}]}]},{"linkId":"section_vitals","text":"2. Patient Vitals Matrix","item":[{"linkId":"systolic_bp","text":"Systolic Blood Pressure","answer":[{"valueDecimal":148}]}]},{"linkId":"section_clinical","text":"3. Diagnostic Findings & Diagnostics","item":[{"linkId":"condition_search","text":"Search Confirmed Diagnosis","answer":[{"valueString":"chronic hypertension"}]}]},{"linkId":"section_medications","text":"4. Medication Management & Prescriptions","item":[{"linkId":"medication_search","text":"Search Prescribed Medications","answer":[{"valueString":"[object Object]"}]}]}]}', 'pending_review', '2026-07-07T15:21:07.570Z');
INSERT INTO local_holding_queue (session_id, room_id, raw_transcript, questionnaire_response_json, status, captured_at) VALUES ('sess-1784347903476', 'clinic-services-registry-v1', 'The patient is a 45 year old male with blood pressure 150', '{"resourceType":"QuestionnaireResponse","questionnaire":"Questionnaire/clinic-services-registry-v1","status":"completed","item":[]}', 'pending_review', '2026-07-18T04:11:43.476Z');
INSERT INTO local_holding_queue (session_id, room_id, raw_transcript, questionnaire_response_json, status, captured_at) VALUES ('sess-1784348258116', 'clinic-services-registry-v1', 'female patient bp 150', '{"resourceType":"QuestionnaireResponse","questionnaire":"Questionnaire/clinic-services-registry-v1","status":"completed","item":[]}', 'pending_review', '2026-07-18T04:17:38.116Z');
INSERT INTO local_holding_queue (session_id, room_id, raw_transcript, questionnaire_response_json, status, captured_at) VALUES ('sess-1784351124379', 'advanced-clinical-matrix-v1', 'Patient is a female presenting in clinic today. Checked vitals showing stable diastolic metrics tracking, but an advanced systolic reading of 148. She has an active history of chronic hypertension. For management, we are initiating a new prescription order for oral tablet lisinopril 10mg.', '{"resourceType":"QuestionnaireResponse","questionnaire":"Questionnaire/advanced-clinical-matrix-v1","status":"completed","item":[{"linkId":"section_demographics","text":"1. Administrative Demographics","item":[{"linkId":"patient_gender","text":"Biological Sex at Birth","answer":[{"valueString":"female"}]}]},{"linkId":"section_vitals","text":"2. Patient Vitals Matrix","item":[{"linkId":"systolic_bp","text":"Systolic Blood Pressure","answer":[{"valueDecimal":148}]}]},{"linkId":"section_medications","text":"4. Medication Management & Prescriptions","item":[{"linkId":"medication_search","text":"Search Prescribed Medications","answer":[{"valueString":"lisinopril"}]}]}]}', 'pending_review', '2026-07-18T05:05:24.379Z');

// Design-time codegen tool (run manually / via `npm run build:kernel`, not part of the live
// Worker): walks the vendored @smile-cdr/fhirts TypeScript class declarations via ts-morph and,
// for every FHIR resource listed in config.validation.allowedResources, produces:
//   - data/graphs/<resource>.graph.json  — one "shard" per resource with every reachable field
//     path, its FHIR type, a pre-baked GBNF grammar fragment, and searchable keyword metadata.
//     yaml-to-questionnaire.js validates room-layout YAML field paths against these shards
//     (via data/graphs.bundle.json — see build-graphs-bundle.js, run right after this).
//   - data/form-schematics.schema.json — the structural JSON Schema used to validate the
//     overall shape of a room-layout YAML file (also consumed by yaml-to-questionnaire.js).
//
// Formerly a standalone project (clinux-kernel) that generated these into its own config/
// folder, requiring a manual copy into clinuxflow-api/data/ afterwards — that copy step is what
// let the two repos' copies of system-forms-library.json drift 737 lines apart. Folded in here
// so generation and consumption share one repo and one npm script chain (build:kernel).
// Run with:
//   node tools/dictionary-builder.js
import { Project } from 'ts-morph';
import fs from 'fs';
import path from 'path';

// 1. LOAD EXTERNAL ORCHESTRATION CONFIGURATION MATRIX
const configPath = path.join(process.cwd(), 'tools', 'clinixflow.config.json');
if (!fs.existsSync(configPath)) {
    console.error(`❌ Configuration file missing at: ${configPath}. Run initialization sweeps first.`);
    process.exit(1);
}
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

const CLASSES_DIR = path.join(process.cwd(), config.directories.classes);
const SHARDED_GRAPHS_DIR = path.join(process.cwd(), 'data', 'graphs');
const OUTPUT_SCHEMA_PATH = path.join(process.cwd(), config.directories.schemaOutput);

// Ensure the target sharded graphs output folder exists safely
if (!fs.existsSync(SHARDED_GRAPHS_DIR)) {
    fs.mkdirSync(SHARDED_GRAPHS_DIR, { recursive: true });
}

// Initialize High-Performance ts-morph AST project compiler thread wrapper
const project = new Project();
project.addSourceFilesAtPaths(path.join(CLASSES_DIR, '*.d.ts'));

// English Stop-Words list to filter out noise from JSDoc strings
const ENGLISH_STOP_WORDS = new Set(['the', 'and', 'this', 'that', 'with', 'from', 'for', 'was', 'were', 'been', 'each', 'such', 'their', 'them', 'these', 'into', 'under', 'over', 'above', 'value', 'element', 'property', 'type', 'contains']);


/**
 * Cleanly isolates JSDoc annotations directly from the source code nodes
 */
function extractPropertyJsDoc(propertyDeclaration) {
    try {
        const jsDocs = propertyDeclaration.getJsDocs();
        if (jsDocs && jsDocs.length > 0) {
            return jsDocs[0].getDescription().replace(/\r?\n/g, ' ').replace(/\s+/g, ' ').trim();
        }
    } catch (err) {}
    return "";
}

/**
 * Extracts explicit string-literal union choices from a property's AST type node
 * (e.g. `gender: "male" | "female"` -> ["male", "female"]). Returns [] if the property
 * isn't a string-literal union or its type can't be resolved.
 */
function extractEnumChoices(prop) {
    try {
        if (prop && typeof prop.getType === 'function') {
            const propType = prop.getType();
            if (propType.isUnion()) {
                return propType.getUnionTypes()
                    .filter(t => t.isStringLiteral())
                    .map(t => t.getLiteralValue());
            }
        }
    } catch (e) {
        // Fall back gracefully if type unions cannot be parsed on this element
    }
    return [];
}

/**
 * UNIFIED FIELD-LEVEL REVERSE GOVERNANCE GRAMMAR GENERATOR
 * Builds a GBNF grammar fragment constraining an LLM's output for this field to its FHIR type
 * (numbers, booleans, explicit enum choices, or free text), wrapped as an array rule when the
 * underlying property is a list.
 */
function prebuildNodeGbnfRule(placeholderId, targetClassName, cleanTargetClassNameLower, isArrayStructure, enumChoicesList) {
    let baseValueGrammar = `[^\\\"\\r\\n]*`; // Default string parameter constraint

    // 1. LAYER METRIC CONSTRAINTS OVER CORE PRIMITIVES
    if (targetClassName === 'number' || targetClassName === 'decimal' || targetClassName === 'integer') {
        baseValueGrammar = `[0-9]+ (\".\" [0-9]+)?`;
    } else if (targetClassName === 'boolean') {
        baseValueGrammar = `(true | false)`;
    } else if (cleanTargetClassNameLower === 'codeableconcept' || enumChoicesList.length > 0) {
        if (enumChoicesList.length > 0) {
            // Securely escape and map explicit choices (e.g., "male" | "female")
            baseValueGrammar = `(${enumChoicesList.map(c => `\\\"${c}\\\"`).join(' | ')})`;
        } else {
            baseValueGrammar = `[a-zA-Z0-9\\-]+`;
        }
    }

    // 2. NATIVELY PACKAGE ARRAYS INTO CLEAN LIST FORMATS
    if (isArrayStructure) {
        return `\"\\\"${placeholderId}\\\": [ \" ( \\\"\" ${baseValueGrammar} \"\\\"\" ( \", \\\"\" ${baseValueGrammar} \"\\\"\" )* )? \" ]\"`;
    }

    // 3. RETURN STRING-ESCAPED ENCLOSURES TO ENSURE 100% LLM INFERENCE ACCURACY
    return `\"\\\"${placeholderId}\\\": \\\"\" ${baseValueGrammar} \"\\\"\"`;
}

/**
 * RECURSIVE METADATA TRAVERSAL ENGINE (With Case-Insensitive Polymorphic Filtering)
 */
function walkClassProperties(properties, prefix, graphNodesCollection, seenTypesStack = new Set()) {
    const lowercasePolymorphicPrimitives = config.validation.runtimePolymorphicPrimitives.map(p => p.toLowerCase());

    properties.forEach(prop => {
        if (!prop || typeof prop.getName !== 'function') return;
        
        const propName = prop.getName();
        if (config.validation.systemOverheadProperties.includes(propName)) return;

        const currentPath = prefix ? `${prefix}.${propName}` : propName;
        
        let targetClassName = 'string';
        let isArrayStructure = false;

        if (typeof prop.getTypeNode === 'function') {
            const typeNode = prop.getTypeNode();
            if (typeNode) {
                const typeText = typeNode.getText().trim();
                // Match standard array declaration syntax signatures natively
                isArrayStructure = typeText.endsWith('[]') || typeText.startsWith('Array<');
                
                let cleaned = typeText.replace(/\[\]$/, '').replace('Array<', '').replace('>', '').trim();
                targetClassName = cleaned.includes('.') ? cleaned.split('.').pop() : cleaned;
            }
        }

        const capturedJsDoc = extractPropertyJsDoc(prop);
        const primitiveTypes = ['string', 'number', 'boolean', 'any', 'Date', 'Code', 'Uri', 'Instant', 'decimal', 'integer'];
        const isPrimitive = primitiveTypes.includes(targetClassName);
        const cleanTargetClassNameLower = targetClassName.toLowerCase();

        // ─── OPTIMIZATION: DETERMINE UI COMPONENT AND FILL SNEAK-PEEK DEFAULTS ───
        let matchingUiComponent = "TextInput";
        if (targetClassName === 'number' || targetClassName === 'decimal' || targetClassName === 'integer') {
            matchingUiComponent = "NumericInput";
        } else if (targetClassName === 'boolean') {
            matchingUiComponent = "Checkbox";
        } else if (lowercasePolymorphicPrimitives.includes(cleanTargetClassNameLower) || currentPath.toLowerCase().includes('code')) {
            matchingUiComponent = isArrayStructure ? "MultiSelect" : "Dropdown";
        }

        const pathTokens = currentPath.split('.');
        const leafFieldName = pathTokens[pathTokens.length - 1];
        const placeholderId = leafFieldName.replace(/([A-Z])/g, '_$1').toLowerCase().replace(/^_+/, '');

        // Pre-bake compliant reverse YAML blocks directly using synchronized 'path' parameters
        const reverseYamlSnippet = `      - id: "${placeholderId}"\n        path: "${currentPath}"\n        label: "Enter ${leafFieldName}"\n        description: "${capturedJsDoc || 'Clinical data element.'}"\n        uiComponent: "${matchingUiComponent}"`;
        const enumChoices = extractEnumChoices(prop);
        const prebuiltGbnf = prebuildNodeGbnfRule(placeholderId, targetClassName, cleanTargetClassNameLower, isArrayStructure, enumChoices);

        // ─── EXPANDED CORE KEYWORDS SYSTEMpass MATRICES ───
        // Combines path fragments, UI choices, and tokenized JSDoc descriptions
        const rawKeywordBlock = [
            ...pathTokens.flatMap(t => t.split(/(?=[A-Z])/)),
            matchingUiComponent,
            ...capturedJsDoc.toLowerCase().split(/[\s\._-]/)
        ].map(w => w.replace(/[^a-zA-Z]/g, '').toLowerCase());

        const richCoreKeywords = Array.from(new Set(
            rawKeywordBlock.filter(w => w.length > 2 && !ENGLISH_STOP_WORDS.has(w))
        ));

        let outboundEdgesList = null;

        if (cleanTargetClassNameLower === 'reference') {
            outboundEdgesList = [];
            
            // Default fallback routing target inferred from field label names
            let guessedTarget = leafFieldName.replace(/^[A-Z]/, c => c.toUpperCase());
            if (leafFieldName === 'subject') guessedTarget = 'Patient';
            if (leafFieldName === 'provider') guessedTarget = 'Practitioner';
            
            outboundEdgesList.push({
                relationshipType: `${leafFieldName}-link`,
                targetResource: guessedTarget,
                traversalPath: `${guessedTarget}.id`
            });
        }

        const graphNode = {
            path: currentPath, // FIXED: Unified tracker string changed from 'nodeId' to 'path' for schema alignment
            resourceType: pathTokens[0],
            primitiveType: isPrimitive ? targetClassName : (lowercasePolymorphicPrimitives.includes(cleanTargetClassNameLower) ? `polymorphic-${cleanTargetClassNameLower}` : "object"),
            isArray: isArrayStructure,
            arrayTargetType: isArrayStructure ? targetClassName : null, // FIXED: Captures exact resource data type of the list element
            outboundEdges: outboundEdgesList, // Explicit structural linkages added here natively
            gbnfRuleToken: prebuiltGbnf, // Pre-baked right inside your sharded schema dictionary
            semanticFingerprint: {
                jsdocDefinition: capturedJsDoc,
                coreKeywords: richCoreKeywords
            },
            reverseYamlSnippet: reverseYamlSnippet
        };

        if (enumChoices.length > 0) {
            graphNode.choices = enumChoices;
        }

        graphNodesCollection.push(graphNode);

        // ─── DEFENESIVE POLYMORPHIC ESCAPE HATCH INTERCEPTOR ───
        if (!isPrimitive && !targetClassName.endsWith('Enum')) {
            if (lowercasePolymorphicPrimitives.includes(cleanTargetClassNameLower)) {
                return; // Safe recursive truncation path to isolate circular loops
            }

            // Guard 1: Local Type-Stack memory backtrack barrier check
            if (seenTypesStack.has(targetClassName) || config.validation.circularDependencyPruneTokens.includes(targetClassName)) return;

            const targetClassDecl = project.getSourceFiles().map(sf => sf.getClass(targetClassName)).find(c => c !== undefined);
            if (targetClassDecl) {
                const nestedProps = targetClassDecl.getProperties();
                if (nestedProps && nestedProps.length > 0) {
                    const nextTypesStack = new Set(seenTypesStack);
                    nextTypesStack.add(targetClassName);
                    walkClassProperties(nestedProps, currentPath, graphNodesCollection, nextTypesStack);
                }
            }
        }
    });
}

/**
 * ENHANCED IN-MEMORY SHARDER EXECUTION PIPELINE
 */
function buildShardedHealthcareKnowledgeGraph() {
    console.log(`🧠 Mining Source Definitions & Splitting Graph Shards by Resource Name...`);
    const masterUniquePathsList = [];

    config.validation.allowedResources.forEach(resourceName => {
        const sourceFile = project.getSourceFile(path.join(CLASSES_DIR, `${resourceName}.d.ts`));
        if (!sourceFile) return;

        const classDecl = sourceFile.getClass(resourceName);
        if (classDecl) {
            const rawResourceNodesCollection = [];
            walkClassProperties(classDecl.getProperties(), resourceName, rawResourceNodesCollection, new Set([resourceName]));

            // Deduplicate local path nodes to keep the vector search boundaries crisp
            const uniqueResourceNodes = [];
            const seenPaths = new Set();

            rawResourceNodesCollection.forEach(node => {
                if (!seenPaths.has(node.path)) {
                    seenPaths.add(node.path);
                    uniqueResourceNodes.push(node);
                    masterUniquePathsList.push(node.path);
                }
            });

            // ─── SHARD FILE FLUSHING PASS ───
            // Saves each resource profile into its own high-speed isolated graph shard file
            const shardOutputPath = path.join(SHARDED_GRAPHS_DIR, `${resourceName.toLowerCase()}.graph.json`);
            fs.writeFileSync(shardOutputPath, JSON.stringify(uniqueResourceNodes, null, 2), 'utf8');
            console.log(`  ➔ Saved isolated graph shard: data/graphs/${resourceName.toLowerCase()}.graph.json [${uniqueResourceNodes.length} nodes]`);
        }
    });

    // 2. BACKWARDS-COMPATIBLE PASS: Output structural Ajv validation schema file
    const metaSchema = {
        "$schema": "http://json-schema.org",
        "title": "ClinixFlow Validation Schema Base",
        "type": "object",
        "required": ["formId", "composition"],
        "properties": {
            "formId": { "type": "string" },
            "composition": {
                "type": "array",
                "items": {
                    "type": "object",
                    "required": ["resourceType", "fields"],
                    "properties": {
                        "resourceType": { "type": "string", "enum": config.validation.allowedResources },
                        "fields": {
                            "type": "array",
                            "items": {
                                "type": "object",
                                "required": ["id", "path", "label", "uiComponent"],
                                "properties": {
                                    "id": { "type": "string" },
                                    "path": { "type": "string", "enum": masterUniquePathsList },
                                    "label": { "type": "string" },
                                    "uiComponent": { "type": "string", "enum": config.validation.allowedUiComponents },
                                    "description": { "type": "string" },
                                    "required": { "type": "boolean" },
                                    "choices": { "type": "array", "items": { "type": "string" } },
                                    "unit": { "type": "string" },
                                    "valueSetUrl": { "type": "string" }
                                }
                            }
                        }
                    }
                }
            }
        }
    };

    fs.writeFileSync(OUTPUT_SCHEMA_PATH, JSON.stringify(metaSchema, null, 2), 'utf8');
    console.log(`\n✅ Global Design-Time Validation Schema updated at: ${OUTPUT_SCHEMA_PATH}`);
}

buildShardedHealthcareKnowledgeGraph();

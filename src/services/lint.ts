/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

import * as nls from 'vscode-nls';
import { TextDocument } from '../cssLanguageTypes';
import { CSSDataManager } from '../languageFacts/dataManager';
import * as languageFacts from '../languageFacts/facts';
import * as nodes from '../parser/cssNodes';
import { union } from '../utils/arrays';
import { LintConfigurationSettings, Rule, Rules, Settings } from './lintRules';
import calculateBoxModel, { Element } from './lintUtil';


const localize = nls.loadMessageBundle();

class NodesByRootMap {
	public data: { [name: string]: { nodes: nodes.Node[]; names: string[] } } = {};

	public add(root: string, name: string, node?: nodes.Node | null): void {
		let entry = this.data[root];
		if (!entry) {
			entry = { nodes: [], names: [] };
			this.data[root] = entry;
		}
		entry.names.push(name);
		if (node) {
			entry.nodes.push(node);
		}
	}
}

export class LintVisitor implements nodes.IVisitor {

	static entries(node: nodes.Node, document: TextDocument, settings: LintConfigurationSettings, cssDataManager: CSSDataManager, entryFilter?: number): nodes.IMarker[] {
		const visitor = new LintVisitor(document, settings, cssDataManager);
		node.acceptVisitor(visitor);
		visitor.completeValidations();
		return visitor.getEntries(entryFilter);
	}

	static prefixes = [
		'-s2-', // Quite common
		//		'-xv-', '-atsc-', '-wap-', '-khtml-', 'mso-', 'prince-', '-ah-', '-hp-', '-ro-', '-rim-', '-tc-' // Quite un-common
	];

	private warnings: nodes.IMarker[] = [];
	private settings: LintConfigurationSettings;
	private keyframes: NodesByRootMap;
	private documentText: string;

	private validProperties: { [name: string]: boolean };

	private constructor(document: TextDocument, settings: LintConfigurationSettings, private cssDataManager: CSSDataManager) {
		this.settings = settings;
		this.documentText = document.getText();
		this.keyframes = new NodesByRootMap();
		this.validProperties = {};

		const properties = settings.getSetting(Settings.ValidProperties);
		if (Array.isArray(properties)) {
			properties.forEach((p) => {
				if (typeof p === 'string') {
					const name = p.trim().toLowerCase();
					if (name.length) {
						this.validProperties[name] = true;
					}
				}
			});
		}
	}

	private isValidPropertyDeclaration(element: Element): boolean {
		const propertyName = element.fullPropertyName;
		return this.validProperties[propertyName];
	}

	private fetch(input: Element[], s: string): Element[] {
		const elements: Element[] = [];

		for (const curr of input) {
			if (curr.fullPropertyName === s) {
				elements.push(curr);
			}
		}

		return elements;
	}

	private fetchWithValue(input: Element[], s: string, v: string): Element[] {
		const elements: Element[] = [];
		for (const inputElement of input) {
			if (inputElement.fullPropertyName === s) {
				const expression = inputElement.node.getValue();
				if (expression && this.findValueInExpression(expression, v)) {
					elements.push(inputElement);
				}
			}
		}
		return elements;
	}

	private findValueInExpression(expression: nodes.Expression, v: string): boolean {
		let found = false;
		expression.accept(node => {
			if (node.type === nodes.NodeType.Identifier && node.matches(v)) {
				found = true;
			}
			return !found;
		});
		return found;
	}


	public getEntries(filter: number = (nodes.Level.Warning | nodes.Level.Error)): nodes.IMarker[] {
		return this.warnings.filter(entry => {
			return (entry.getLevel() & filter) !== 0;
		});
	}

	private addEntry(node: nodes.Node, rule: Rule, details?: string): void {
		const entry = new nodes.Marker(node, rule, this.settings.getRule(rule), details);
		this.warnings.push(entry);
	}

	private getMissingNames(expected: string[], actual: string[]): string | null {
		const expectedClone: (string | null)[] = expected.slice(0); // clone

		for (let i = 0; i < actual.length; i++) {
			const k = expectedClone.indexOf(actual[i]);
			if (k !== -1) {
				expectedClone[k] = null;
			}
		}
		let result: string | null = null;
		for (let i = 0; i < expectedClone.length; i++) {
			const curr = expectedClone[i];
			if (curr) {
				if (result === null) {
					result = localize('namelist.single', "'{0}'", curr);
				} else {
					result = localize('namelist.concatenated', "{0}, '{1}'", result, curr);
				}
			}
		}
		return result;
	}

	public visitNode(node: nodes.Node): boolean {
		switch (node.type) {
			case nodes.NodeType.UnknownAtRule:
				return this.visitUnknownAtRule(<nodes.UnknownAtRule>node);
			case nodes.NodeType.Keyframe:
				return this.visitKeyframe(<nodes.Keyframe>node);
			case nodes.NodeType.FontFace:
				return this.visitFontFace(<nodes.FontFace>node);
			case nodes.NodeType.Ruleset:
				return this.visitRuleSet(<nodes.RuleSet>node);
			case nodes.NodeType.SimpleSelector:
				return this.visitSimpleSelector(<nodes.SimpleSelector>node);
			case nodes.NodeType.Function:
				return this.visitFunction(<nodes.Function>node);
			case nodes.NodeType.NumericValue:
				return this.visitNumericValue(<nodes.NumericValue>node);
			case nodes.NodeType.Import:
				return this.visitImport(<nodes.Import>node);
			case nodes.NodeType.HexColorValue:
				return this.visitHexColorValue(<nodes.HexColorValue>node);
			case nodes.NodeType.Prio:
				return this.visitPrio(node);
			case nodes.NodeType.IdentifierSelector:
				return this.visitIdentifierSelector(node);
		}
		return true;
	}

	private completeValidations() {
		this.validateKeyframes();
	}

	private visitUnknownAtRule(node: nodes.UnknownAtRule): boolean {
		const atRuleName = node.getChild(0);
		if (!atRuleName) {
			return false;
		}

		const atDirective = this.cssDataManager.getAtDirective(atRuleName.getText());
		if (atDirective) {
			return false;
		}

		this.addEntry(atRuleName, Rules.UnknownAtRules, `Unknown at rule ${atRuleName.getText()}`);
		return true;
	}

	private visitKeyframe(node: nodes.Keyframe): boolean {
		const keyword = node.getKeyword();
		if (!keyword) {
			return false;
		}

		const text = keyword.getText();
		this.keyframes.add(node.getName(), text, (text !== '@keyframes') ? keyword : null);
		return true;
	}

	private validateKeyframes(): boolean {
		// @keyframes
		for (const name in this.keyframes.data) {
			const actual = this.keyframes.data[name].names;
			const needsStandard = (actual.indexOf('@keyframes') === -1);
			if (!needsStandard && actual.length === 1) {
				continue;
			}
		}

		return true;
	}

	private visitSimpleSelector(node: nodes.SimpleSelector): boolean {
		/////////////////////////////////////////////////////////////
		//	Lint - The universal selector (*) is known to be slow.
		/////////////////////////////////////////////////////////////
		const firstChar = this.documentText.charAt(node.offset);

		if (node.length === 1 && firstChar === '*') {
			this.addEntry(node, Rules.UniversalSelector);
		}

		return true;
	}

	private visitIdentifierSelector(node: nodes.Node): boolean {
		/////////////////////////////////////////////////////////////
		//	Lint - Avoid id selectors
		/////////////////////////////////////////////////////////////
		this.addEntry(node, Rules.AvoidIdSelector);
		return true;
	}

	private visitImport(node: nodes.Import): boolean {
		/////////////////////////////////////////////////////////////
		//	Lint - Import statements shouldn't be used, because they aren't offering parallel downloads.
		/////////////////////////////////////////////////////////////
		this.addEntry(node, Rules.ImportStatemement);
		return true;
	}

	private visitRuleSet(node: nodes.RuleSet): boolean {
		/////////////////////////////////////////////////////////////
		//	Lint - Don't use empty rulesets.
		/////////////////////////////////////////////////////////////
		const declarations = node.getDeclarations();
		if (!declarations) {
			// syntax error
			return false;
		}


		if (!declarations.hasChildren()) {
			this.addEntry(node.getSelectors(), Rules.EmptyRuleSet);
		}

		const propertyTable: Element[] = [];
		for (const element of declarations.getChildren()) {
			if (element instanceof nodes.Declaration) {
				propertyTable.push(new Element(element));
			}
		}

		/////////////////////////////////////////////////////////////
		// the rule warns when it finds:
		// width being used with border, border-left, border-right, padding, padding-left, or padding-right
		// height being used with border, border-top, border-bottom, padding, padding-top, or padding-bottom
		// No error when box-sizing property is specified, as it assumes the user knows what he's doing.
		// see https://github.com/CSSLint/csslint/wiki/Beware-of-box-model-size
		/////////////////////////////////////////////////////////////
		const boxModel = calculateBoxModel(propertyTable);
		if (boxModel.width) {
			let properties: Element[] = [];
			if (boxModel.right.value) {
				properties = union(properties, boxModel.right.properties);
			}
			if (boxModel.left.value) {
				properties = union(properties, boxModel.left.properties);
			}
			if (properties.length !== 0) {
				for (const item of properties) {
					this.addEntry(item.node, Rules.BewareOfBoxModelSize);
				}
				this.addEntry(boxModel.width.node, Rules.BewareOfBoxModelSize);
			}
		}
		if (boxModel.height) {
			let properties: Element[] = [];
			if (boxModel.top.value) {
				properties = union(properties, boxModel.top.properties);
			}
			if (boxModel.bottom.value) {
				properties = union(properties, boxModel.bottom.properties);
			}
			if (properties.length !== 0) {
				for (const item of properties) {
					this.addEntry(item.node, Rules.BewareOfBoxModelSize);
				}
				this.addEntry(boxModel.height.node, Rules.BewareOfBoxModelSize);
			}
		}

		/////////////////////////////////////////////////////////////
		//	Properties ignored due to display
		/////////////////////////////////////////////////////////////

		// With 'display: inline-block', 'float' has no effect
		let displayElems = this.fetchWithValue(propertyTable, 'display', 'inline-block');
		if (displayElems.length > 0) {
			const elem = this.fetch(propertyTable, 'float');
			for (let index = 0; index < elem.length; index++) {
				const node = elem[index].node;
				const value = node.getValue();
				if (value && !value.matches('none')) {
					this.addEntry(node, Rules.PropertyIgnoredDueToDisplay, localize('rule.propertyIgnoredDueToDisplayInlineBlock', "inline-block is ignored due to the float. If 'float' has a value other than 'none', the box is floated and 'display' is treated as 'block'"));
				}
			}
		}

		// With 'display: block', 'vertical-align' has no effect
		displayElems = this.fetchWithValue(propertyTable, 'display', 'block');
		if (displayElems.length > 0) {
			const elem = this.fetch(propertyTable, 'vertical-align');
			for (let index = 0; index < elem.length; index++) {
				this.addEntry(elem[index].node, Rules.PropertyIgnoredDueToDisplay, localize('rule.propertyIgnoredDueToDisplayBlock', "Property is ignored due to the display. With 'display: block', vertical-align should not be used."));
			}
		}

		/////////////////////////////////////////////////////////////
		//	Avoid 'float'
		/////////////////////////////////////////////////////////////

		const elements: Element[] = this.fetch(propertyTable, 'float');
		for (let index = 0; index < elements.length; index++) {
			const element = elements[index];
			if (!this.isValidPropertyDeclaration(element)) {
				this.addEntry(element.node, Rules.AvoidFloat);
			}
		}

		/////////////////////////////////////////////////////////////
		//	Don't use duplicate declarations.
		/////////////////////////////////////////////////////////////
		for (let i = 0; i < propertyTable.length; i++) {
			const element = propertyTable[i];
			if (element.fullPropertyName !== 'background' && !this.validProperties[element.fullPropertyName]) {
				const value = element.node.getValue();
				if (value && this.documentText.charAt(value.offset) !== '-') {
					const elements = this.fetch(propertyTable, element.fullPropertyName);
					if (elements.length > 1) {
						for (let k = 0; k < elements.length; k++) {
							const value = elements[k].node.getValue();
							if (value && this.documentText.charAt(value.offset) !== '-' && elements[k] !== element) {
								this.addEntry(element.node, Rules.DuplicateDeclarations);
							}
						}
					}
				}
			}
		}

		/////////////////////////////////////////////////////////////
		//	Unknown propery & When using a vendor-prefixed gradient, make sure to use them all.
		/////////////////////////////////////////////////////////////

		const isExportBlock = node.getSelectors().matches(":export");

		if (!isExportBlock) {
			const propertiesBySuffix = new NodesByRootMap();
			let containsUnknowns = false;

			for (const element of propertyTable) {
				const decl = element.node;
				if (this.isCSSDeclaration(decl)) {
					let name = element.fullPropertyName;
					const firstChar = name.charAt(0);

					if (firstChar === '-') {
						if (name.charAt(1) !== '-') { // avoid css variables
							if (!this.cssDataManager.isKnownProperty(name) && !this.validProperties[name]) {
								this.addEntry(decl.getProperty()!, Rules.UnknownVendorSpecificProperty);
							}
							const nonPrefixedName = decl.getNonPrefixedPropertyName();
							propertiesBySuffix.add(nonPrefixedName, name, decl.getProperty());
						}
					} else {
						const fullName = name;
						if (firstChar === '*' || firstChar === '_') {
							this.addEntry(decl.getProperty()!, Rules.IEStarHack);
							name = name.substr(1);
						}

						// _property and *property might be contributed via custom data
						if (!this.cssDataManager.isKnownProperty(fullName) && !this.cssDataManager.isKnownProperty(name)) {
							if (!this.validProperties[name]) {
								this.addEntry(decl.getProperty()!, Rules.UnknownProperty, localize('property.unknownproperty.detailed', "Unknown property: '{0}'", decl.getFullPropertyName()));
							}
						}

						propertiesBySuffix.add(name, name, null); // don't pass the node as we don't show errors on the standard
					}
				} else {
					containsUnknowns = true;
				}
			}

			if (!containsUnknowns) { // don't perform this test if there are
				for (const suffix in propertiesBySuffix.data) {
					const entry = propertiesBySuffix.data[suffix];
					const actual = entry.names;

					const needsStandard = this.cssDataManager.isStandardProperty(suffix) && (actual.indexOf(suffix) === -1);
					if (!needsStandard && actual.length === 1) {
						continue; // only the non-vendor specific rule is used, that's fine, no warning
					}

					const expected: string[] = [];
					for (let i = 0, len = LintVisitor.prefixes.length; i < len; i++) {
						const prefix = LintVisitor.prefixes[i];
						if (this.cssDataManager.isStandardProperty(prefix + suffix)) {
							expected.push(prefix + suffix);
						}
					}

					const missingVendorSpecific = this.getMissingNames(expected, actual);
					if (missingVendorSpecific || needsStandard) {
						for (const node of entry.nodes) {
							if (needsStandard) {
								const message = localize('property.standard.missing', "Also define the standard property '{0}' for compatibility", suffix);
								this.addEntry(node, Rules.IncludeStandardPropertyWhenUsingVendorPrefix, message);
							}
							if (missingVendorSpecific) {
								const message = localize('property.vendorspecific.missing', "Always include all vendor specific properties: Missing: {0}", missingVendorSpecific);
								this.addEntry(node, Rules.AllVendorPrefixes, message);
							}
						}
					}
				}
			}
		}


		return true;
	}

	private visitPrio(node: nodes.Node) {
		/////////////////////////////////////////////////////////////
		//	Don't use !important
		/////////////////////////////////////////////////////////////
		this.addEntry(node, Rules.AvoidImportant);
		return true;
	}

	private visitNumericValue(node: nodes.NumericValue): boolean {
		/////////////////////////////////////////////////////////////
		//	0 has no following unit
		/////////////////////////////////////////////////////////////
		const funcDecl = (node.findParent(nodes.NodeType.Function) as nodes.Function);
		if (funcDecl && funcDecl.getName() === 'calc') {
			return true;
		}

		const decl = <nodes.Declaration>node.findParent(nodes.NodeType.Declaration);
		if (decl) {
			const declValue = decl.getValue();
			if (declValue) {
				const value = node.getValue();
				if (!value.unit || languageFacts.units.length.indexOf(value.unit.toLowerCase()) === -1) {
					return true;
				}
				if (parseFloat(value.value) === 0.0 && !!value.unit && !this.validProperties[decl.getFullPropertyName()]) {
					this.addEntry(node, Rules.ZeroWithUnit);
				}
			}
		}
		return true;
	}

	private visitFontFace(node: nodes.FontFace): boolean {
		const declarations = node.getDeclarations();
		if (!declarations) {
			// syntax error
			return false;
		}

		let definesSrc = false, definesFontFamily = false;
		let containsUnknowns = false;
		for (const node of declarations.getChildren()) {
			if (this.isCSSDeclaration(node)) {
				const name = node.getProperty()!.getName().toLowerCase();
				if (name === 'src') { definesSrc = true; }
				if (name === 'font-family') { definesFontFamily = true; }
			} else {
				containsUnknowns = true;
			}
		}

		if (!containsUnknowns && (!definesSrc || !definesFontFamily)) {
			this.addEntry(node, Rules.RequiredPropertiesForFontFace);
		}

		return true;
	}

	private isCSSDeclaration(node: nodes.Node): node is nodes.Declaration {
		if (node instanceof nodes.Declaration) {
			if (!(<nodes.Declaration>node).getValue()) {
				return false;
			}
			const property = (<nodes.Declaration>node).getProperty();
			if (!property) {
				return false;
			}
			const identifier = property.getIdentifier();
			if (!identifier || identifier.containsInterpolation()) {
				return false;
			}
			return true;
		}
		return false;
	}

	private visitHexColorValue(node: nodes.HexColorValue): boolean {
		// Rule: #eeff0011 or #eeff00 or #ef01 or #ef0
		const length = node.length;
		if (length !== 9 && length !== 7 && length !== 5 && length !== 4) {
			this.addEntry(node, Rules.HexColorLength);
		}
		return false;
	}

	private visitFunction(node: nodes.Function): boolean {

		const fnName = node.getName().toLowerCase();
		let expectedAttrCount = -1;
		let actualAttrCount = 0;

		switch (fnName) {
			case 'rgb(':
			case 'hsl(':
				expectedAttrCount = 3;
				break;
			case 'rgba(':
			case 'hsla(':
				expectedAttrCount = 4;
				break;
		}

		if (expectedAttrCount !== -1) {
			node.getArguments().accept(n => {
				if (n instanceof nodes.BinaryExpression) {
					actualAttrCount += 1;
					return false;
				}
				return true;
			});

			if (actualAttrCount !== expectedAttrCount) {
				this.addEntry(node, Rules.ArgsInColorFunction);
			}
		}

		return true;
	}
}

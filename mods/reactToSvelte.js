const { readFileSync, writeFileSync } = require('fs');
const { basename, dirname, parse, relative } = require('path');

function setModuleSource(node, val, token) {
  if (token) {
    node.raw = node.raw.replace(token, val);
    node.value = node.value.replace(token, val);
  }
  else {
    node.raw = `'${val}'`;
    node.value = val;
  }
}

const aliasToRelativePath = ({
  alias,
  aliasAbsPath,
  modulePath,
  outputPath,
}) => {
  const transformed = modulePath.replace(alias, aliasAbsPath);
  let relativePath = relative(outputPath, transformed);

  if(!relativePath.startsWith('.')) relativePath = `./${ relativePath }`;
  
  return relativePath;
};

const parseNestedStyles = (css) => {
  const ruleNames = [];
  let bracketIndent = '';
  const rawLines = css.split('\n');
  let rulesOffset;
  const lines = rawLines.reduce((arr, line) => {
    if (line === '--') return arr;
    
    let _line = line;
    
    if (!rulesOffset) {
      const space = (_line.match(/^\s+/) || [''])[0];
      rulesOffset = new RegExp(`^${space}`);
    }
    
    _line = _line.replace(rulesOffset, '');
    
    if (_line.includes('}')) {
      ruleNames.pop();
      if (ruleNames.length) return arr;
    }
    else if (_line.includes('{') && !_line.includes('}')) {
      bracketIndent = (_line.match(/^\s+/) || [''])[0];
      ruleNames.push((_line.match(/^(?:\s+)?([^ {]+) {/) || [,''])[1]);
    
      const nestedRuleName = ruleNames.join(' ').replace(' &', '');
      _line = `${bracketIndent}${nestedRuleName} {`;
    
      // remove empty parent
      const nextLine = rawLines[arr.length + 1];
      if (!nextLine.trim()) {
        rawLines[arr.length + 1] = '--';
        return arr;
      }
    }
    
    const prevLine = arr[arr.length - 1];
    const trimmedLine = _line.trim();
    
    // close current rule
    if (prevLine && !prevLine.includes('}') && trimmedLine === '') {
      _line = '}';
    }
    else if (trimmedLine === '' && prevLine.trim() === '') {
      return arr;
    }
    
    // remove nested indentation
    if (ruleNames.length > 1 && bracketIndent) {
      _line = _line.replace(new RegExp(`^${bracketIndent}`), '');
    }
    
    arr.push(_line);
    
    return arr;
  }, []);
  
  return lines;
};

module.exports = function transformer(file, api) {
  const fullFilePath = file.path;
  const fileContents = file.source;
  const jsCS = api.jscodeshift;
  const recastOpts = { // https://github.com/benjamn/recast/blob/master/lib/options.ts
    quote: 'single',
    tabWidth: 2,
  };
  
  const fileFolder = dirname(fullFilePath);
  let fileName = parse(basename(fullFilePath)).name;
  if (fileName === 'index') fileName = basename(fileFolder);
  
  const root = jsCS(fileContents);
  const refs = [];
  
  // [imports] =================================================================
  const imports = [];
  const SRC_REPO__ALIAS_PATH__ROOT = `${fullFilePath.split('/src')[0]}/src`;
  const SRC_REPO__ALIAS_PATH__COMPONENTS = `${SRC_REPO__ALIAS_PATH__ROOT}/client/components`;
  const SRC_REPO__ALIAS_PATH__UTILS = `${SRC_REPO__ALIAS_PATH__ROOT}/utils`;
  const cssVarMap = {};
  let cssRules;
  
  const templateLiteralToString = ({ expressions, quasis }) => {
    let str = '';
    quasis.forEach((q, ndx) => {
      const exp = expressions[ndx] ? cssVarMap[expressions[ndx].name] : '';
      str += `${q.value.raw}${exp}`;
    });
    return str;
  };
  
  root.find(jsCS.ImportDeclaration)
  	.filter((np) => {
      const modulePath = np.value.source.value;
      return !/(react|prop-types)/.test(modulePath);
  	})
    .forEach((np) => {
      const moduleSrc = np.value.source;
      const modulePath = moduleSrc.value;
      let keep = true;
      
      if (modulePath.startsWith('ROOT')) {
        const relativePath = aliasToRelativePath({
          alias: 'ROOT',
          aliasAbsPath: SRC_REPO__ALIAS_PATH__ROOT,
          modulePath,
          outputPath: SRC_REPO__ALIAS_PATH__COMPONENTS,
        });
        setModuleSource(moduleSrc, relativePath);
        
        if (modulePath.endsWith('conf.app')) {
          setModuleSource(moduleSrc, 'constants', 'conf.app');
        }
      }
      else if (modulePath.startsWith('UTILS')) {
        const relativePath = aliasToRelativePath({
          alias: 'UTILS',
          aliasAbsPath: SRC_REPO__ALIAS_PATH__ROOT,
          modulePath,
          outputPath: SRC_REPO__ALIAS_PATH__COMPONENTS,
        });
        setModuleSource(moduleSrc, relativePath);
        
        if (modulePath.endsWith('fetch')) {
          setModuleSource(moduleSrc, '../fetch');
        }
      }
      else if (modulePath.endsWith('styles')) {
        keep = false;
        
        const styles = (modulePath.startsWith('.'))
          ? readFileSync(`${fileFolder}/${modulePath}.js`, 'utf8')
          : readFileSync(`${modulePath}.js`, 'utf8');
        const stylesRoot = jsCS(styles);
        const cssNode = stylesRoot.find(jsCS.TaggedTemplateExpression, { tag: { name: 'css' } }).get().node.quasi;
        
        stylesRoot.find(jsCS.VariableDeclarator, { init: { type: 'Literal' } }).forEach((np) => {
          const { id, init } = np.node;
          cssVarMap[id.name] = init.value;
        });
        
        const WRAPPED_SPACE = '  ';
        let unwrappedRootRule = false;
        const cssLines = templateLiteralToString(cssNode)
          .replace(/^\n/, '').replace(/\n$/, '')
          .split('\n')
          .map((line, ndx) => {
            let _line = line;
            
            if (ndx === 0 && !_line.includes('{')) {
              unwrappedRootRule = true;
              _line = `.${cssVarMap.ROOT_CLASS} {\n${WRAPPED_SPACE}${_line}`;
            }
            if (unwrappedRootRule) {
              if (_line.trim() === '') {
                _line = `${WRAPPED_SPACE}}\n`;
                unwrappedRootRule = false;
              }
              else {
                _line = `${WRAPPED_SPACE}${_line}`;
              }
            }
            
            return _line;
          });
        
        cssRules = parseNestedStyles(cssLines.join('\n'));
      }
      
      if (keep) imports.push(jsCS(np.node).toSource(recastOpts));
    });
  
  // ===========================================================================
  
  // jsCS.types.Type.def('SvelteIf')
  //   .bases('IfStatement')
  //   .build('name', 'program')
  //   .field('name', jsCS.types.builtInTypes.string)
  //   .field('program', jsCS.types.Type.def('Program'));
  // jsCS.types.finalize();
  
  const removeThis = (expr) => {
    let propName;
    
    if (expr.object && expr.object.type && expr.object.type === 'ThisExpression') {
      propName = expr.property.name;
      expr.name = propName;
      expr.type = 'Identifier';
    }
    
    return propName;
  }
  
  root.find(jsCS.JSXIdentifier).forEach((np) => {
    const attrName = np.value.name;
    if (attrName === 'className') np.value.name = 'class';
    else if (attrName === 'defaultValue') np.value.name = 'value';
    else if (attrName.startsWith('on')) {
      const parentName = np.parentPath.parentPath.parentPath.value.name.name;
      const standardDomNode = /[a-z]/.test(parentName[0]);
      
      removeThis(np.parentPath.value.value.expression);
      
      if (standardDomNode) {
        const [, type] = attrName.split('on');
        np.value.name = `on:${type.toLowerCase()}`;
      }
    }
    else if (attrName === 'ref') {
      np.value.name = 'bind:this';
      refs.push(removeThis(np.parentPath.value.value.expression));
    }
  });
  
  const getOp = (op) => {
    let _op = op.operator || op.name;
    if (op.argument) _op += getOp(op.argument);
    return _op;
  };
  root.find(jsCS.LogicalExpression).forEach((np) => {
    if (np.value.operator === '&&') {
      const leftOp = getOp(np.value.left);
      console.log(leftOp);
    }
  });
  
  // define any refs
  // const scriptTag = root.find(jsCS.JSXOpeningElement, { name: { name: 'script' } }).get();
  // refs.forEach((ref) => {
  //   scriptTag.parentPath.value.children.push(
  //     jsCS.variableDeclaration('let', [jsCS.variableDeclarator(jsCS.identifier(ref), null)]),
  //     '\n'
  //   );
  // });
  
  // TODO:
  // [props]
  // - Remove calls like `const { seriesName } = this.props;` create exported props
  // - Remove `this.props.<FUNC_OR_PROP>`, just call function or use variable
  // [state]
  // - Any `this.state` initialization in `constructor` should be converted to `let` vars
  // - Replace calls like `this.setState({ applyBtnDisabled: true });` to reference internal `let` vars
  // - Remove destructuring `const { applyBtnDisabled } = this.state;`
  // [refs]
  // - Any `this.seriesNameInputRef = React.createRef();` should be converted to empty `let` vars
  // - `this.seriesNameInputRef.current.value`
  //   - Remove `this.`
  //   - Remove `current.`
  // [class]
  // - `class={`${ ROOT_CLASS } ${ styles }`}`
  //   - Remove ` ${ styles }`
  //   - Get `ROOT_CLASS` value from `styles.js` and swap it in.
  //   - If there aren't anymore template strings, change to quoted item
  // [markup]
  // - Replace blocks `{!!seriesAlias && (` with custom `{#if}`
  // - Something's off with the internal spacing of the nested items
  // [this]
  // - Remove any remaining references to `this.`
  
  const isClassComponent = !!root.find(jsCS.ClassDeclaration).length;
  const methods = [];
  let markup = [];
  if (isClassComponent) {
    root.find(jsCS.MethodDefinition).forEach((np) => {
      const methodName = np.value.key.name;
      
      switch(methodName) {
        case 'constructor': break;
        case 'render': {
          const returnNode = jsCS(np).find(jsCS.ReturnStatement).get().value.argument;
          markup = jsCS([returnNode.openingElement, ...returnNode.children, returnNode.closingElement]).toSource(recastOpts);
          break;
        }
        default: {
          let funcDef = jsCS(np).toSource(recastOpts);
          const funcLines = funcDef.split('\n');
          funcLines[0] = `function ${funcLines[0]}`;
          funcDef = funcLines.join('\n');
          methods.push(funcDef);
        }
      }
    });
  }
  
  const tabOver = (arr, space) => arr.map(n => n.split('\n').map(l => `${space}${l}`).join('\n'));
  const SCRIPT_SPACE = '  ';
  
  const output = [
    '<script>',
    tabOver(imports, SCRIPT_SPACE).join('\n'),
    '  ',
    tabOver(methods, SCRIPT_SPACE).join('\n\n'),
    '</script>',
    '',
    markup.join(''),
    '',
    '<style>',
    tabOver(cssRules, SCRIPT_SPACE).join('\n'),
    '</style>',
    '',
  ].join('\n');
  
  writeFileSync(`${SRC_REPO__ALIAS_PATH__COMPONENTS}/${fileName}.svelte`, output);
  
  return output;
}

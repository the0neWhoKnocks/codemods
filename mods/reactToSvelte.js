const { writeFileSync } = require('fs');
const { basename, dirname, parse } = require('path');

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
        if (modulePath.endsWith('conf.app')) {
          moduleSrc.raw = moduleSrc.raw.replace('conf.app', 'constants');
          moduleSrc.value = modulePath.replace('conf.app', 'constants');
        }
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
  // [imports]
  // - transform aliases
  //   - `ROOT` -> create relative path from current location up to `src/`
  //     - some components may be nested, but won't be once converted, so have the final path be `src/client/components`
  //   - 'UTILS' -> create relative path from current location up to `src/utils`
  // - If there's an import for `styles`, load and parse it
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
  ].join('\n');
  // return root.toSource();
  
  writeFileSync(`${fileFolder}/${fileName}.svelte`, output);
  
  return output;
}

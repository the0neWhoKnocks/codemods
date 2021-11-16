import React from 'react';
import styles, {
  MODIFIER__DISABLED,
  ROOT_CLASS,
} from './styles';

const FunctionalComponent = ({
  children,
  childStyle,
  className,
  disabled,
  id,
  style,
  title,
  toggled,
}) => {
  let rootModifier = '';
  
  if (disabled) rootModifier += MODIFIER__DISABLED;

  return (
    <div className={`${ ROOT_CLASS } ${ styles } ${ className } ${ rootModifier }`} style={style}>
      <input
        className={`${ ROOT_CLASS }__input`}
        disabled={disabled}
        type="checkbox"
        id={id}
      />
      <label
        className={`${ ROOT_CLASS }__btn`}
        htmlFor={id}
        style={childStyle}
        title={title}
      >
        <div className={`${ ROOT_CLASS }__content-wrapper`}>
          {children}
        </div>
      </label>
    </div>
  );
};

export default FunctionalComponent;
